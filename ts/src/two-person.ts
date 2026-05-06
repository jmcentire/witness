// State-based two-person window enforcement.
//
// Sim-vetted ADR-001 rejects time-based windows for two-person
// approval (5min and "forever" both wrong). Instead: at decision
// creation, witness hashes the caller's `context` (predicate state +
// action payload) into a SHA-256 hex digest; at second-operator answer
// time, witness recomputes the hash from CURRENT state.
//
// - Hashes match → context unchanged → second approval valid.
// - Hashes differ → world has moved on → second approval rejected with
//   reason `context_changed`; the decision flips to terminal status
//   `context_changed`. Consumer must re-request under fresh state.
//
// This solves the "09:00 trigger + 17:00 approval" anti-pattern (the
// emergency that justified the action is over) AND the "senior in a
// meeting" case (an honest backlog of an ongoing emergency stays
// approvable indefinitely).
//
// The hash function is intentionally minimal: canonical JSON
// (sorted keys at every level) + SHA-256 hex digest. Determinism is
// the only requirement; security is not — this hash isn't a token.

import { createHash } from 'node:crypto';

/**
 * Canonical JSON: stable across object key ordering, deterministic
 * for arrays / primitives / null. NaN, Infinity, undefined inside
 * values become null (matching JSON.stringify's behavior). Throws on
 * cycles — callers must pass plain data.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) return null;
    return value;
  }
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'undefined' || t === 'function' || t === 'symbol') return null;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('witness.canonicalJson: cycle detected');
    seen.add(value);
    const out = value.map((v) => canonicalize(v, seen));
    seen.delete(value);
    return out;
  }
  if (t === 'object') {
    if (seen.has(value)) throw new Error('witness.canonicalJson: cycle detected');
    seen.add(value);
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = canonicalize(obj[k], seen);
    }
    seen.delete(value);
    return out;
  }
  return null;
}

/**
 * SHA-256 hex digest of the canonical JSON form. Stable, deterministic,
 * collision-resistant for our state-snapshot use.
 */
export function contextHash(context: unknown): string {
  const canonical = canonicalJson(context);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Compare a stored context hash to a freshly-computed one. Returns
 * true when the two-person window is still valid (state unchanged).
 */
export function contextStillMatches(storedHash: string, currentContext: unknown): boolean {
  return contextHash(currentContext) === storedHash;
}
