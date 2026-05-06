"""Async HTTP client for the witness server.

Usage::

    from witness_client import WitnessClient

    async with WitnessClient(base_url="http://localhost:8787") as w:
        decision_id = await w.ask(
            kind="scram.confirm-global-readonly",
            input={"reason": "burn-rate spike"},
            response_shape={"decision": "string"},
            authorized_roles=["scram.operator"],
            surfaces=["inbox", "pagerduty"],
            context_snapshot={"phase": "emergency", "tenants": ["a", "b"]},
        )

The client is intentionally a thin transport adapter. All policy
(state-based two-person windows, ACK fallback, audit) lives
server-side in the TypeScript witness library and is mirrored over
HTTP without translation. See ts/server/http.ts for endpoint shapes.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .types import AnswerResult, Approval, CancelResult, Decision


class WitnessError(Exception):
    """Raised when the witness server returns a non-success response.

    Carries the HTTP status code and the parsed error body when
    available; consumers can branch on ``status`` to distinguish
    transient vs. terminal failures.
    """

    def __init__(self, status: int, body: dict[str, Any] | str | None) -> None:
        self.status = status
        self.body = body
        super().__init__(f"witness error {status}: {body!r}")


class WitnessClient:
    """Async HTTP client for the witness server.

    Construct as a context manager so the underlying httpx.AsyncClient
    is closed cleanly even on exception::

        async with WitnessClient(base_url="...") as w:
            ...

    Or pass an existing httpx.AsyncClient via ``client=`` (useful when
    multiplexing connections across multiple stack clients in one
    service).
    """

    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout: float = 10.0,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def __aenter__(self) -> "WitnessClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ---------------- ask ----------------

    async def ask(
        self,
        *,
        kind: str,
        input: Any,  # noqa: A002 — match TS API shape
        response_shape: dict[str, Any],
        authorized_roles: list[str],
        surfaces: list[str],
        timeout_ms: int | None = None,
        context_snapshot: Any = None,
    ) -> str:
        """Create a decision; returns the decision id.

        Decisions are fire-and-forget over HTTP — the caller gets back
        an id and is responsible for polling ``get_decision`` or
        listening on its own surface webhook. There is no synchronous
        ``ask`` over HTTP because human decisions take seconds-to-hours
        and HTTP timeouts don't.
        """
        body: dict[str, Any] = {
            "kind": kind,
            "input": input,
            "responseShape": response_shape,
            "authorizedRoles": authorized_roles,
            "surfaces": surfaces,
        }
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        if context_snapshot is not None:
            body["contextSnapshot"] = context_snapshot
        result = await self._post("/v1/decisions", body, expect=201)
        return str(result["decisionId"])

    # ---------------- get / list ----------------

    async def get_decision(self, decision_id: str) -> Decision:
        """Fetch a single decision by id."""
        result = await self._get(f"/v1/decisions/{decision_id}")
        return Decision.model_validate(result)

    async def list_open(self, authorized_for: str | list[str]) -> list[Decision]:
        """List open decisions visible to the given role(s)."""
        roles = authorized_for if isinstance(authorized_for, str) else ",".join(authorized_for)
        result = await self._get(f"/v1/decisions?authorized={roles}")
        decisions = result.get("decisions", [])
        return [Decision.model_validate(d) for d in decisions]

    # ---------------- answer ----------------

    async def answer(
        self,
        *,
        decision_id: str,
        operator: str,
        answer: dict[str, Any],
        rationale: str,
        current_context: Any = None,
    ) -> AnswerResult:
        """Record an operator's answer.

        For two-person decisions, the SECOND call must pass
        ``current_context`` matching the snapshot supplied at ask time
        — otherwise witness rejects with status='context_changed'.
        """
        body: dict[str, Any] = {
            "operator": operator,
            "answer": answer,
            "rationale": rationale,
        }
        if current_context is not None:
            body["currentContext"] = current_context
        result = await self._post(f"/v1/decisions/{decision_id}/answer", body, expect=200)
        return AnswerResult.model_validate(result)

    # ---------------- ack ----------------

    async def acknowledge_delivery(
        self,
        *,
        decision_id: str,
        surface: str,
        operator: str | None = None,
    ) -> dict[str, Any]:
        """Surfaces call this to mark a decision as delivered.

        Returns ``{"accepted": bool, "alreadyAcked": bool}``. Callers
        typically don't need the response — this is fire-and-forget
        from a Slack bot / PD webhook / email parser.
        """
        body: dict[str, Any] = {"surface": surface}
        if operator is not None:
            body["operator"] = operator
        return await self._post(f"/v1/decisions/{decision_id}/ack", body, expect=200)

    # ---------------- cancel ----------------

    async def cancel(
        self,
        *,
        decision_id: str,
        operator: str,
        reason: str,
    ) -> CancelResult:
        """Abandon a pending decision."""
        body = {"operator": operator, "reason": reason}
        result = await self._post(f"/v1/decisions/{decision_id}/cancel", body, expect=200)
        return CancelResult.model_validate(result)

    # ---------------- health ----------------

    async def health(self) -> dict[str, Any]:
        return await self._get("/v1/health")

    # ---------------- internals ----------------

    async def _get(self, path: str) -> dict[str, Any]:
        response = await self._client.get(f"{self._base}{path}")
        return self._parse(response, expect=200)

    async def _post(self, path: str, body: dict[str, Any], *, expect: int) -> dict[str, Any]:
        response = await self._client.post(
            f"{self._base}{path}",
            json=body,
            headers={"content-type": "application/json"},
        )
        return self._parse(response, expect=expect)

    def _parse(self, response: httpx.Response, *, expect: int) -> dict[str, Any]:
        if response.status_code != expect:
            try:
                body = response.json()
            except Exception:  # noqa: BLE001 — best-effort error decoding
                body = response.text
            raise WitnessError(response.status_code, body)
        try:
            return dict(response.json())
        except Exception as err:  # noqa: BLE001
            raise WitnessError(response.status_code, response.text) from err


@asynccontextmanager
async def open_client(base_url: str) -> AsyncIterator[WitnessClient]:
    """Convenience context manager: ``async with open_client(url) as w:``."""
    client = WitnessClient(base_url=base_url)
    try:
        yield client
    finally:
        await client.aclose()
