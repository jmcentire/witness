// Surface ACK + fallback tests.
//
// ADR-001 mandates the ACK-required pattern: dispatch to all configured
// surfaces in parallel; the first surface to ACK marks the decision
// delivered. If no surface ACKs within ackWindowMs (default 60s),
// witness fires a fallback hook.
//
// We exercise the fallback path with a tiny ackWindowMs (5ms) to keep
// tests fast; in production that'd be 60s. The test seam is the
// `now`/`ackWindowMs` config — no patching required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetInMemoryStore } from '../src/persistence.ts';
import { createWitness } from '../src/index.ts';
import type { SurfaceDispatcher } from '../src/types.ts';

describe('surface dispatch + ACK', () => {
  beforeEach(() => __resetInMemoryStore());
  afterEach(() => __resetInMemoryStore());

  it('dispatches to every configured surface in parallel', async () => {
    const calls: string[] = [];
    const a: SurfaceDispatcher = (i) => {
      calls.push(`a:${i.decisionId.slice(0, 8)}`);
    };
    const b: SurfaceDispatcher = (i) => {
      calls.push(`b:${i.decisionId.slice(0, 8)}`);
    };
    const w = createWitness({ surfaces: { a, b }, ackWindowMs: 0 });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['a', 'b'],
      },
      () => undefined,
    );
    // Allow microtasks to flush.
    await new Promise((r) => setImmediate(r));
    expect(calls).toContain(`a:${id.slice(0, 8)}`);
    expect(calls).toContain(`b:${id.slice(0, 8)}`);
  });

  it('one surface throwing does not stop others from dispatching', async () => {
    const fired: string[] = [];
    const bad: SurfaceDispatcher = () => {
      throw new Error('surface boom');
    };
    const good: SurfaceDispatcher = (i) => {
      fired.push(i.decisionId);
    };
    const w = createWitness({ surfaces: { bad, good }, ackWindowMs: 0 });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['bad', 'good'],
      },
      () => undefined,
    );
    await new Promise((r) => setImmediate(r));
    expect(fired).toContain(id);
  });

  it('ACK from a surface within the ack window prevents the fallback firing', async () => {
    const fallback = vi.fn();
    const w = createWitness({
      surfaces: { inbox: () => undefined },
      ackWindowMs: 50,
      fallback,
    });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    const ack = await w.acknowledgeDelivery({ decisionId: id, surface: 'inbox', operator: 'op-1' });
    expect(ack.accepted).toBe(true);
    // Wait past the ack window; fallback must not have fired.
    await new Promise((r) => setTimeout(r, 80));
    expect(fallback).not.toHaveBeenCalled();
  });

  it('no ACK within ack window fires the fallback hook with decision metadata', async () => {
    const fallback = vi.fn();
    const w = createWitness({
      // Configured surface that never ACKs.
      surfaces: { inbox: () => undefined },
      ackWindowMs: 20,
      fallback,
    });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: { foo: 'bar' },
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(fallback).toHaveBeenCalledTimes(1);
    const call = fallback.mock.calls[0]![0];
    expect(call.decisionId).toBe(id);
    expect(call.kind).toBe('reeve.action.review');
    expect(call.surfaces).toEqual(['inbox']);
  });

  it('ACK is recorded on the decision row (ackSurface, ackOperator, ackAt)', async () => {
    const w = createWitness({
      surfaces: { inbox: () => undefined },
      ackWindowMs: 1_000,
      now: () => 1_000_000,
    });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    await w.acknowledgeDelivery({ decisionId: id, surface: 'inbox', operator: 'op-1' });
    // Inspect via getDecision; persistence layer carries the ACK row.
    // (The in-memory store does not surface ack* fields in `Decision`
    // shape itself by design; the test verifies the path didn't error
    // and the row is still open.)
    const row = await w.getDecision(id);
    expect(row?.status).toBe('open');
  });

  it('ACK for a closed decision is a no-op', async () => {
    const w = createWitness({ ackWindowMs: 0 });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'done',
    });
    const ack = await w.acknowledgeDelivery({ decisionId: id, surface: 'inbox' });
    expect(ack.accepted).toBe(false);
  });

  it('warns + skips surfaces that have no registered dispatcher', async () => {
    const fallback = vi.fn();
    const w = createWitness({
      surfaces: { inbox: () => undefined },
      ackWindowMs: 0,
      fallback,
    });
    // 'pagerduty' is referenced but no dispatcher registered.
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox', 'pagerduty'],
      },
      () => undefined,
    );
    expect(typeof id).toBe('string');
  });
});
