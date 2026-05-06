-- 001_witness_decisions: human-in-the-loop decision ledger.
--
-- Schema mirrors ADR-001-extraction.md. Co-located with consumer DB in
-- V1 (Reeve is first consumer). Context-hash columns implement the
-- state-based two-person window: at decision creation, the caller
-- supplies a context (predicate state + payload); witness hashes the
-- canonical JSON form. When the second operator answers, witness
-- recomputes the hash from current context and compares; mismatch
-- rejects the second approval as "context_changed".

CREATE TABLE IF NOT EXISTS witness_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable kind identifier (e.g., 'reeve.action.review',
  -- 'scram.confirm-global-readonly'). Drives two-person policy.
  kind              text NOT NULL,
  -- Original input that triggered the decision. Opaque to witness.
  input             jsonb NOT NULL,
  -- Schema for the response body (operator's answer must match).
  response_shape    jsonb NOT NULL,
  -- Roles authorized to answer.
  authorized_roles  text[] NOT NULL,
  -- Surfaces to dispatch to (inbox, pagerduty, slack, email).
  surfaces          text[] NOT NULL,
  -- SHA-256 hex digest of canonical JSON of context (for state-based
  -- two-person window). Required when policy says two-person; nullable
  -- otherwise.
  context_hash      text,
  -- Two-person policy snapshot at creation time (immutable per
  -- decision). True = second operator required; false = single OK.
  requires_two_person boolean NOT NULL DEFAULT false,
  -- Soft timeout for first answer (escalation hint, not enforcement).
  timeout_at        timestamptz NOT NULL,
  -- ACK-required surface delivery: any surface that ACKs sets these.
  ack_at            timestamptz,
  ack_surface       text,
  ack_operator      text,
  -- Fallback fired? (no surface ACKed within ack window)
  fallback_fired_at timestamptz,
  -- First operator's answer (when given).
  first_operator    text,
  first_at          timestamptz,
  first_rationale   text,
  first_answer      jsonb,
  -- Second operator's answer (when two-person policy applies).
  second_operator   text,
  second_at         timestamptz,
  second_rationale  text,
  second_answer     jsonb,
  -- Final disposition. 'awaiting-second' is a transient state used
  -- when the first operator has answered but the kind requires a
  -- second; the row stays 'open' in this implementation, with
  -- first_operator populated, until close.
  status            text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'approved', 'rejected', 'cancelled', 'timeout', 'context_changed')
  ),
  -- For cancelled / context_changed terminal states.
  closed_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);

-- Hot path: list-open queries by authorized role and freshness.
CREATE INDEX IF NOT EXISTS witness_decisions_open_idx
  ON witness_decisions (status, timeout_at)
  WHERE status = 'open';

-- Audit / analytics: kind history.
CREATE INDEX IF NOT EXISTS witness_decisions_kind_idx
  ON witness_decisions (kind, created_at DESC);

-- Two-person partial: rows in 'awaiting-second' substate (status=open
-- with first_operator non-null). Powers operator inboxes that surface
-- "this needs a second look".
CREATE INDEX IF NOT EXISTS witness_decisions_awaiting_second_idx
  ON witness_decisions (kind, first_at DESC)
  WHERE status = 'open' AND first_operator IS NOT NULL;
