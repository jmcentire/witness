"""Pydantic models matching the witness TypeScript API.

These mirror the shapes in ts/src/types.ts. Field names are
camelCase on the wire (TS convention); Pydantic aliases let Python
callers use snake_case when constructing models.

The types here are deliberately loose where the wire is loose — the
``input``, ``answer``, ``response_shape``, and ``current_context``
payloads are opaque dicts because witness itself treats them as
opaque. Consumer-side typing is the caller's responsibility (which is
why witness exists: to coordinate decisions, not to schema-check
payloads).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


DecisionStatus = Literal[
    "open",
    "approved",
    "rejected",
    "cancelled",
    "timeout",
    "context_changed",
]
"""Lifecycle status of a witness decision; mirrors TS DecisionStatus."""


class _CamelModel(BaseModel):
    """Pydantic base that accepts camelCase aliases on input + output.

    The witness HTTP server emits camelCase JSON; Python callers can
    construct models with snake_case kwargs and round-trip cleanly.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class Decision(_CamelModel):
    """A pending or completed witness decision.

    Mirrors the TypeScript ``Decision<TIn, TOut>`` shape — generics
    are flattened to ``Any`` on the Python side because Pydantic
    can't represent the TS-style phantom types. Consumers that want
    typed payloads layer their own ``BaseModel`` for ``input`` /
    ``answer`` on top.
    """

    id: str
    kind: str
    input: Any
    response_shape: dict[str, Any] = Field(alias="responseShape")
    authorized_roles: list[str] = Field(alias="authorizedRoles")
    surfaces: list[str]
    requires_two_person: bool = Field(alias="requiresTwoPerson")
    context_hash: str | None = Field(default=None, alias="contextHash")
    timeout_at: int = Field(alias="timeoutAt")
    first_operator: str | None = Field(default=None, alias="firstOperator")
    first_at: int | None = Field(default=None, alias="firstAt")
    first_rationale: str | None = Field(default=None, alias="firstRationale")
    first_answer: Any = Field(default=None, alias="firstAnswer")
    second_operator: str | None = Field(default=None, alias="secondOperator")
    second_at: int | None = Field(default=None, alias="secondAt")
    second_rationale: str | None = Field(default=None, alias="secondRationale")
    second_answer: Any = Field(default=None, alias="secondAnswer")
    status: DecisionStatus
    closed_reason: str | None = Field(default=None, alias="closedReason")
    created_at: int = Field(alias="createdAt")
    closed_at: int | None = Field(default=None, alias="closedAt")


class Approval(_CamelModel):
    """Approval payload returned to a caller awaiting a human decision."""

    decision_id: str = Field(alias="decisionId")
    decided_at: int = Field(alias="decidedAt")
    decided_by: str = Field(alias="decidedBy")
    rationale: str
    output: Any
    co_decided_by: str | None = Field(default=None, alias="coDecidedBy")
    co_decided_at: int | None = Field(default=None, alias="coDecidedAt")
    co_rationale: str | None = Field(default=None, alias="coRationale")
    status: Literal["approved", "rejected"]


class AnswerResult(_CamelModel):
    """Result of POST /v1/decisions/:id/answer.

    Three shapes:
      - status='awaiting-second' (two-person, first answer recorded)
      - status='closed' with .approval populated
      - status='context_changed' (state-based two-person window expired)
    """

    status: Literal["awaiting-second", "closed", "context_changed"]
    decision_id: str | None = Field(default=None, alias="decisionId")
    approval: Approval | None = None
    reason: str | None = None


class CancelResult(_CamelModel):
    """Result of POST /v1/decisions/:id/cancel."""

    decision_id: str = Field(alias="decisionId")
    status: Literal["cancelled"]
