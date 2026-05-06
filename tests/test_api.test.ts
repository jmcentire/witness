// API-level tests: ask / askAsync / listOpen / cancel / answer round-trips.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetInMemoryStore } from '../src/persistence.ts';
import { createWitness } from '../src/index.ts';

describe('witness API — ask / answer / listOpen / cancel', () => {
  beforeEach(() => __resetInMemoryStore());
  afterEach(() => __resetInMemoryStore());

  it('ask resolves with Approval when the decision is answered', async () => {
    const w = createWitness({ ackWindowMs: 0 });
    const askPromise = w.ask({
      kind: 'reeve.action.review',
      input: { actionType: 'send_email_reply', to: 'c@example.com' },
      responseShape: { decision: 'string' },
      authorizedRoles: ['reeve.owner'],
      surfaces: ['inbox'],
    });
    // Find the open decision so we can answer it.
    const open = await w.listOpen('reeve.owner');
    expect(open.length).toBe(1);
    const id = open[0]!.id;
    await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'safe reply',
    });
    const approval = await askPromise;
    expect(approval.decisionId).toBe(id);
    expect(approval.decidedBy).toBe('op-1');
    expect(approval.status).toBe('approved');
  });

  it('ask resolves with rejected approval when a decision is cancelled', async () => {
    // Cancellation surfaces to the awaiting caller as a rejected
    // approval whose output carries reason: 'cancelled'. This is the
    // contract: the caller doesn't need to handle a separate
    // exception path for cancels — same disposition as a
    // human-reasoned rejection.
    const w = createWitness({ ackWindowMs: 0 });
    const askPromise = w.ask({
      kind: 'reeve.action.review',
      input: {},
      responseShape: {},
      authorizedRoles: ['reeve.owner'],
      surfaces: ['inbox'],
    });
    const open = await w.listOpen('reeve.owner');
    const id = open[0]!.id;
    await w.cancel({ decisionId: id, operator: 'op-1', reason: 'no longer needed' });
    const approval = await askPromise;
    expect(approval.status).toBe('rejected');
    expect(approval.output).toMatchObject({ reason: 'cancelled' });
  });

  it('listOpen filters by authorized role', async () => {
    const w = createWitness({ ackWindowMs: 0 });
    await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    await w.askAsync(
      {
        kind: 'scram.confirm-tenant',
        input: {},
        responseShape: {},
        authorizedRoles: ['scram.operator'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    const reeveOpen = await w.listOpen('reeve.owner');
    const scramOpen = await w.listOpen('scram.operator');
    expect(reeveOpen.length).toBe(1);
    expect(scramOpen.length).toBe(1);
    expect(reeveOpen[0]!.kind).toBe('reeve.action.review');
    expect(scramOpen[0]!.kind).toBe('scram.confirm-tenant');
  });

  it('listOpen accepts an array of roles and unions across them', async () => {
    const w = createWitness({ ackWindowMs: 0 });
    await w.askAsync(
      {
        kind: 'a',
        input: {},
        responseShape: {},
        authorizedRoles: ['role-a'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    await w.askAsync(
      {
        kind: 'b',
        input: {},
        responseShape: {},
        authorizedRoles: ['role-b'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    const both = await w.listOpen(['role-a', 'role-b']);
    expect(both.length).toBe(2);
  });

  it('listOpen excludes terminal decisions', async () => {
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
      rationale: 'k',
    });
    const open = await w.listOpen('reeve.owner');
    expect(open.length).toBe(0);
  });

  it('cancel on an already-closed decision throws', async () => {
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
      rationale: 'lgtm',
    });
    await expect(
      w.cancel({ decisionId: id, operator: 'op-1', reason: 'too late' }),
    ).rejects.toThrow(/approved/);
  });

  it('answer requires a non-empty rationale', async () => {
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
    await expect(
      w.answer({
        decisionId: id,
        operator: 'op-1',
        answer: { decision: 'approved' },
        rationale: '',
      }),
    ).rejects.toThrow(/rationale/);
  });

  it('cancel requires a non-empty reason', async () => {
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
    await expect(
      w.cancel({ decisionId: id, operator: 'op-1', reason: '' }),
    ).rejects.toThrow(/reason/);
  });

  it('answer on an unknown decision id throws', async () => {
    const w = createWitness({ ackWindowMs: 0 });
    await expect(
      w.answer({
        decisionId: 'no-such-id',
        operator: 'op-1',
        answer: {},
        rationale: 'x',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('decisionFromAnswer accepts boolean approved=false as rejection', async () => {
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
    const r = await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { approved: false, reason: 'no good' },
      rationale: 'wrong',
    });
    expect(r.status).toBe('closed');
    if (r.status === 'closed') expect(r.approval.status).toBe('rejected');
  });

  it('askAsync returns the decision id immediately', async () => {
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
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const row = await w.getDecision(id);
    expect(row?.status).toBe('open');
  });

  it('async callback fires when the decision closes', async () => {
    const w = createWitness({ ackWindowMs: 0 });
    let received: unknown = null;
    const id = await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      (a) => {
        received = a;
      },
    );
    await w.answer({
      decisionId: id,
      operator: 'op-1',
      answer: { decision: 'approved' },
      rationale: 'k',
    });
    expect(received).not.toBeNull();
    const a = received as { decisionId: string; status: string };
    expect(a.decisionId).toBe(id);
    expect(a.status).toBe('approved');
  });
});

describe('witness API — HTTP server', () => {
  beforeEach(() => __resetInMemoryStore());
  afterEach(() => __resetInMemoryStore());

  it('GET /v1/health returns 200', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const app = buildHttpServer();
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('POST /v1/decisions creates a decision and returns id', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const { createWitness: cw } = await import('../src/index.ts');
    const w = cw({ ackWindowMs: 0 });
    const app = buildHttpServer({ witness: w });
    const res = await app.request('/v1/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'reeve.action.review',
        input: { foo: 'bar' },
        responseShape: { decision: 'string' },
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { decisionId: string };
    expect(typeof body.decisionId).toBe('string');
  });

  it('GET /v1/decisions?authorized=role returns open decisions', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const { createWitness: cw } = await import('../src/index.ts');
    const w = cw({ ackWindowMs: 0 });
    const app = buildHttpServer({ witness: w });
    await w.askAsync(
      {
        kind: 'reeve.action.review',
        input: {},
        responseShape: {},
        authorizedRoles: ['reeve.owner'],
        surfaces: ['inbox'],
      },
      () => undefined,
    );
    const res = await app.request('/v1/decisions?authorized=reeve.owner');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decisions: unknown[] };
    expect(body.decisions.length).toBe(1);
  });

  it('POST /v1/decisions/:id/answer closes a single-operator decision', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const { createWitness: cw } = await import('../src/index.ts');
    const w = cw({ ackWindowMs: 0 });
    const app = buildHttpServer({ witness: w });
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
    const res = await app.request(`/v1/decisions/${id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operator: 'op-1',
        answer: { decision: 'approved' },
        rationale: 'lgtm',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('closed');
  });

  it('POST /v1/decisions/:id/ack records the surface ACK', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const { createWitness: cw } = await import('../src/index.ts');
    const w = cw({ ackWindowMs: 1_000 });
    const app = buildHttpServer({ witness: w });
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
    const res = await app.request(`/v1/decisions/${id}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'inbox', operator: 'op-1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
  });

  it('POST /v1/decisions/:id/cancel closes the decision', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const { createWitness: cw } = await import('../src/index.ts');
    const w = cw({ ackWindowMs: 0 });
    const app = buildHttpServer({ witness: w });
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
    const res = await app.request(`/v1/decisions/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operator: 'op-1', reason: 'redundant' }),
    });
    expect(res.status).toBe(200);
    const final = await w.getDecision(id);
    expect(final?.status).toBe('cancelled');
  });

  it('returns 400 when required fields are missing on POST /v1/decisions', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const app = buildHttpServer({ config: { ackWindowMs: 0 } });
    const res = await app.request('/v1/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 on GET /v1/decisions/:id when unknown', async () => {
    const { buildHttpServer } = await import('../server/http.ts');
    const app = buildHttpServer({ config: { ackWindowMs: 0 } });
    const res = await app.request('/v1/decisions/no-such');
    expect(res.status).toBe(404);
  });
});
