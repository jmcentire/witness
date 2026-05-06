// Persistence layer for witness_decisions.
//
// Witness is library-first: its store is pluggable via setStore. The
// default in-memory implementation makes tests deterministic and lets
// Reeve embed witness without an additional pg dep on day one. Reeve's
// production deploy registers a pg-backed store via setStore({...})
// during process startup; the SQL schema in migrations/001 is the
// canonical row shape that backing store must implement.
//
// The interface is intentionally narrow — five operations (insert,
// update, get, query, lock-for-update). Anything richer (joins, full-
// text search, timeseries) belongs in the consumer's own analytics
// layer, not here.

import type { Decision, DecisionId, DecisionStatus, SurfaceName } from './types.js';

/**
 * Filter shape for `query`. Everything is optional; combining filters
 * is AND. The store is expected to honor `status` server-side
 * (it's the only filter cheap to index on; everything else is
 * post-filtered in TS to keep the contract small).
 */
export type DecisionQuery = {
  status?: DecisionStatus | ReadonlyArray<DecisionStatus>;
  /** Authorized-for filter: returns only decisions whose authorizedRoles intersects this set. */
  authorizedFor?: ReadonlyArray<string>;
  kind?: string | ReadonlyArray<string>;
  /** Pagination: created-before cursor and limit. */
  createdBefore?: number;
  limit?: number;
};

/**
 * Update payload for `update`. Patches a single decision row by id.
 * The store performs a compare-and-swap on `status` if `expectedStatus`
 * is provided; this is how the API layer guards against "second
 * operator answers a closed decision" races.
 */
export type DecisionUpdate = Partial<
  Pick<
    Decision,
    | 'firstOperator'
    | 'firstAt'
    | 'firstRationale'
    | 'firstAnswer'
    | 'secondOperator'
    | 'secondAt'
    | 'secondRationale'
    | 'secondAnswer'
    | 'status'
    | 'closedReason'
    | 'closedAt'
  >
> & {
  /** Optional: optimistic guard — update only if current row has this status. */
  expectedStatus?: DecisionStatus;
  /** Surface ACK fields (set when a surface ACKs delivery). */
  ackAt?: number;
  ackSurface?: SurfaceName;
  ackOperator?: string;
  fallbackFiredAt?: number;
};

export interface DecisionStore {
  insert(decision: Decision): Promise<void>;
  get(id: DecisionId): Promise<Decision | null>;
  /**
   * Apply an update. Resolves to the post-update row, or null if the
   * `expectedStatus` guard rejected the write (caller treats this as
   * a no-op and reads the current row to decide what happened).
   */
  update(id: DecisionId, patch: DecisionUpdate): Promise<Decision | null>;
  query(filter: DecisionQuery): Promise<ReadonlyArray<Decision>>;
}

// ============================================================
// Default in-memory store (test + V1 single-process embed).
// ============================================================

class InMemoryStore implements DecisionStore {
  private readonly rows = new Map<DecisionId, Decision>();

  async insert(decision: Decision): Promise<void> {
    if (this.rows.has(decision.id)) {
      throw new Error(`witness: duplicate decision id ${decision.id}`);
    }
    this.rows.set(decision.id, { ...decision });
  }

  async get(id: DecisionId): Promise<Decision | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async update(id: DecisionId, patch: DecisionUpdate): Promise<Decision | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (patch.expectedStatus !== undefined && row.status !== patch.expectedStatus) {
      return null;
    }
    const { expectedStatus: _ignored, ackAt, ackSurface, ackOperator, fallbackFiredAt, ...rest } =
      patch;
    void _ignored;
    void ackAt;
    void ackSurface;
    void ackOperator;
    void fallbackFiredAt;
    const next: Decision = { ...row, ...rest };
    this.rows.set(id, next);
    return { ...next };
  }

  async query(filter: DecisionQuery): Promise<ReadonlyArray<Decision>> {
    const statuses =
      filter.status === undefined
        ? null
        : Array.isArray(filter.status)
          ? new Set(filter.status as ReadonlyArray<DecisionStatus>)
          : new Set([filter.status as DecisionStatus]);
    const kinds =
      filter.kind === undefined
        ? null
        : Array.isArray(filter.kind)
          ? new Set(filter.kind as ReadonlyArray<string>)
          : new Set([filter.kind as string]);
    const authorized = filter.authorizedFor ? new Set(filter.authorizedFor) : null;
    const out: Decision[] = [];
    for (const row of this.rows.values()) {
      if (statuses && !statuses.has(row.status)) continue;
      if (kinds && !kinds.has(row.kind)) continue;
      if (authorized && !row.authorizedRoles.some((r) => authorized.has(r))) continue;
      if (filter.createdBefore !== undefined && row.createdAt >= filter.createdBefore) continue;
      out.push({ ...row });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    if (filter.limit !== undefined) return out.slice(0, filter.limit);
    return out;
  }

  // Test-only: reset the store between tests.
  __reset(): void {
    this.rows.clear();
  }
}

let activeStore: DecisionStore = new InMemoryStore();

export function setStore(store: DecisionStore): void {
  activeStore = store;
}

export function getStore(): DecisionStore {
  return activeStore;
}

/** Test seam: reset the in-memory store between tests. */
export function __resetInMemoryStore(): void {
  if (activeStore instanceof InMemoryStore) {
    activeStore.__reset();
  } else {
    activeStore = new InMemoryStore();
  }
}
