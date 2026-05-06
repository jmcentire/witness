"""witness-client — Python HTTP client for @stack/witness.

This package mirrors the TypeScript API exposed by witness's HTTP
server (see ts/server/http.ts in the witness repo). Python consumers
of witness — scram, baton, sentinel, and any other off-language
service — call the witness HTTP server through this client.

Two architectural decisions are reflected in the API:

1. State-based two-person windows. Decisions that require two
   distinct operators carry a context snapshot; the second operator's
   approval is rejected if the snapshot at second-answer time differs
   from the snapshot at decision creation. The client exposes
   ``ask(..., context_snapshot=...)`` and ``answer(..., current_context=...)``
   to drive this.

2. ACK-required surface delivery. Surfaces (PagerDuty, Slack, email,
   etc.) call back into witness via ``acknowledge_delivery`` to mark
   the decision delivered. If no surface ACKs within the configured
   window, witness fires a fallback hook (configured server-side).

The client is async by default. A blocking helper
(``WitnessClient.ask_sync``) is not provided in V1 — callers should
run an asyncio loop. If a synchronous wrapper is needed in V2, it
will be a thin ``asyncio.run(...)`` adapter.
"""

from .client import WitnessClient, WitnessError
from .types import (
    AnswerResult,
    Approval,
    CancelResult,
    Decision,
    DecisionStatus,
)

__all__ = [
    "AnswerResult",
    "Approval",
    "CancelResult",
    "Decision",
    "DecisionStatus",
    "WitnessClient",
    "WitnessError",
]
