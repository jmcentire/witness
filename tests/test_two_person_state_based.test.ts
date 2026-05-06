// State-based two-person window — the architecturally load-bearing
// behavior of witness. ADR-001 chose this over time-based windows;
// these tests pin the contract.
//
// Coverage:
//   - context_hash matches at second-answer time → approval valid
//   - context_hash differs at second-answer time → second answer rejected
//     and decision flips to terminal `context_changed`
//   - first answer for a single-operator kind closes immediately
//     (no two-person check)
//   - second-operator must be DIFFERENT from first-operator
//   - canonicalJson is deterministic across key orderings (foundation
//     for hash equality)
//   - Decisions requiring two-person without a contextProvider are
//     rejected at askAsync time (fail-loud)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetInMemoryStore } from '../src/persistence.ts';
import {
  canonicalJson,
  contextHash,
  contextStillMatches,
} from '../src/two-person.ts';
import { createWitness } from '../src/index.ts';
import { InMemoryTesseraClient } from '../src/tessera.ts';

describe('canonicalJson', () => {
  it('produces identical output for the same object regardless of key order', () => {
    const a = { kind: 'scram', tenant: 't1', payload: { x: 1, y: 2 } };
    const b = { payload: { y: 2, x: 1 }, tenant: 't1', kind: 'scram' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('differs when values differ', () => {
    expect(canonicalJson({ x: 1 })).not.toBe(canonicalJson({ x: 2 }));
  });

  it('handles nested arrays + nulls + booleans deterministically', () => {
    const v = { a: [1, 2, { b: null, c: true }], z: false };
    expect(canonicalJson(v)).toBe(canonicalJson(JSON.parse(JSON.stringify(v))));
  });

  it('throws on cycles (defensive)', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    expect(() => canonicalJson(obj)).toThrow(/cycle/);
  });
});

describe('contextHash', () => {
  it('SHA-256 hex digest is 64 chars and stable for equal inputs', () => {
    const h = contextHash({ x: 1, y: 'two' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contextHash({ y: 'two', x: 1 })).toBe(h);
  });

  it('differs when context differs', () => {
    expect(contextHash({ x: 1 })).not.toBe(contextHash({ x: 2 }));
  });

  it('contextStillMatches helper agrees with manual recompute', () => {
    const ctx = { phase: 'emergency', tenants: ['a', 'b'] };
    const stored = contextHash(ctx);
    expect(contextStillMatches(stored, { tenants: ['a', 'b'], phase: 'emergency' })).toBe(true);
    expect(contextStillMatches(stored, { phase: 'recovered', tenants: ['a', 'b'] })).toBe(false);
  });
});

describe('two-person window — state-based', () => {
  let tessera: InMemoryTesseraClient;
  beforeEach(() => {
    __resetInMemoryStore();
    tessera = new InMemoryTesseraClient();
  });
  afterEach(() => {
    __resetInMemoryStore();
  });

  it('rejects a two-person ask without a contextProvider', async () => {
    const w = createWitness({
      policies: { 'scram.confirm': { requiresTwoPerson: true } },
      tessera,
    });
    await expect(
      w.askAsync(
        {
          kind: 'scram.confirm',
          input: { tenants: ['a'] },
          responseShape: { decision: 'string' },
          authorizedRoles: ['scram.operator'],
          surfaces: ['inbox'],
        },
        () => undefined,
      ),
    ).rejects.toThrow(/contextProvider/);
  });

  it('first answer leaves a two-person decision in awaiting-second; second matching context closes it', async () => {
    const state = { phase: 'emergency', tenants: ['a', 'b'] };
    const w = createWitness({
      policies: { 'scram.confirm': { requiresTwoPerson: true } },
      tessera,
    });
    const id = await w.askAsync(
      {
        kind: 'scram.confirm',
        input: { tenants: ['a', 'b'] },
        responseShape: { decision: 'string' },
        authorizedRoles: ['scram.operator'],
        surfaces: ['inbox'],
        contextProvider: () => state,
      },
      () => undefined,
    );
    const r1 = await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'looks right',
    });
    expect(r1.status).toBe('awaiting-second');
    const r2 = await w.answer({
      decisionId: id,
      operator: 'op-2',
      answer: { decision: 'approved' },
      rationale: 'second pair of eyes; agree',
    });
    expect(r2.status).toBe('closed');
    if (r2.status === 'closed') {
      expect(r2.approval.status).toBe('approved');
      expect(r2.approval.coDecidedBy).toBe('op-2');
      expect(r2.approval.decidedBy).toBe('op-1');
    }
  });

  it('second answer with DIFFERED context rejects with context_changed', async () => {
    let phase: 'emergency' | 'recovered' = 'emergency';
    const w = createWitness({
      policies: { 'scram.confirm': { requiresTwoPerson: true } },
      tessera,
    });
    const id = await w.askAsync(
      {
        kind: 'scram.confirm',
        input: { tenants: ['a'] },
        responseShape: { decision: 'string' },
        authorizedRoles: ['scram.operator'],
        surfaces: ['inbox'],
        contextProvider: () => ({ phase, tenants: ['a'] }),
      },
      () => undefined,
    );
    await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'first',
    });
    // Emergency resolved; second operator arrives later.
    phase = 'recovered';
    const r2 = await w.answer({
      decisionId: id,
      operator: 'op-2',
      answer: { decision: 'approved' },
      rationale: 'second',
    });
    expect(r2.status).toBe('context_changed');
    const final = await w.getDecision(id);
    expect(final?.status).toBe('context_changed');
    // Tessera should record the context_changed event.
    const types = tessera.events.map((e) => e.type);
    expect(types).toContain('witness.decision.context_changed');
  });

  it('rejects a second answer from the same operator who answered first', async () => {
    const w = createWitness({
      policies: { 'scram.confirm': { requiresTwoPerson: true } },
      tessera,
    });
    const id = await w.askAsync(
      {
        kind: 'scram.confirm',
        input: {},
        responseShape: { decision: 'string' },
        authorizedRoles: ['scram.operator'],
        surfaces: ['inbox'],
        contextProvider: () => ({ phase: 'go' }),
      },
      () => undefined,
    );
    await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'first',
    });
    await expect(
      w.answer({
        decisionId: id,
        operator: 'op-1',
        answer: { decision: 'approved' },
        rationale: 'me again',
      }),
    ).rejects.toThrow(/different operator/);
  });

  it('single-operator kind closes on first answer (no two-person check)', async () => {
    const w = createWitness({
      policies: { 'reeve.action.review': { requiresTwoPerson: false } },
      tessera,
    });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: { actionType: 'send_email_reply' },
        responseShape: { decision: 'string' },
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    const r = await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'lgtm',
    });
    expect(r.status).toBe('closed');
  });

  it('rejected answer (decision: rejected) flips status to rejected on first answer for single-op kind', async () => {
    const w = createWitness({ tessera });
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: { decision: 'string' },
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    const r = await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'rejected', reason: 'not safe' },
      rationale: 'wrong customer',
    });
    expect(r.status).toBe('closed');
    if (r.status === 'closed') expect(r.approval.status).toBe('rejected');
  });

  it('emits the full Tessera lifecycle for a closed two-person decision', async () => {
    const w = createWitness({
      policies: { 'scram.confirm': { requiresTwoPerson: true } },
      tessera,
    });
    const id = await w.askAsync(
      {
        kind: 'scram.confirm',
        input: {},
        responseShape: { decision: 'string' },
        authorizedRoles: ['scram.operator'],
        surfaces: ['inbox'],
        contextProvider: () => ({ phase: 'go' }),
      },
      () => undefined,
    );
    await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'first',
    });
    await w.answer({
      decisionId: id,
      operator: 'op-2',
      answer: { decision: 'approved' },
      rationale: 'second',
    });
    const types = tessera.events.map((e) => e.type);
    expect(types).toContain('witness.decision.created');
    expect(types).toContain('witness.decision.first_answered');
    expect(types).toContain('witness.decision.closed');
  });
});
