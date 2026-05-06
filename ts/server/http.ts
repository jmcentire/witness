// Thin HTTP server exposing witness's TS API to non-TS consumers.
//
// Python clients (scram, baton, sentinel) hit these endpoints via the
// `witness_client` package in py/src/witness_client/. The server is
// intentionally minimal — it's a transport adapter, not a feature
// layer. All policy + persistence + two-person + ACK semantics live
// in the TS library and are inherited here verbatim.
//
// Endpoints (all under /v1):
//   POST   /decisions                 — ask (creates a decision)
//   GET    /decisions/:id             — get a single decision
//   GET    /decisions?authorized=...  — listOpen
//   POST   /decisions/:id/answer      — answer (first or second)
//   POST   /decisions/:id/ack         — surface ACK
//   POST   /decisions/:id/cancel      — cancel
//   GET    /health                    — liveness
//
// The HTTP surface uses askAsync internally — it never blocks the
// connection waiting for human approval (humans take seconds-to-hours;
// HTTP timeouts don't). Callers that need notification-on-close should
// either poll GET /decisions/:id or use the TS library directly.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createWitness } from '../src/index.ts';
import type { WitnessInstance } from '../src/api.ts';
import type { WitnessConfig } from '../src/types.ts';

export type HttpServerOptions = {
  witness?: WitnessInstance;
  /** Build options for createWitness if no preconfigured instance is passed. */
  config?: WitnessConfig;
};

/**
 * Build a Hono app exposing witness over HTTP. Returned bare so callers
 * can mount it under their own server, attach middleware, or run it
 * directly via `serve` (see `startHttpServer`).
 */
export function buildHttpServer(opts: HttpServerOptions = {}): Hono {
  const witness = opts.witness ?? createWitness(opts.config);
  const app = new Hono();

  app.get('/v1/health', (c) => c.json({ status: 'ok', service: 'witness', version: '0.1.0' }));

  // ---------------- ask ----------------
  // POST /v1/decisions
  // Body: { kind, input, responseShape, authorizedRoles, surfaces,
  //         timeoutMs?, contextSnapshot? }
  // contextSnapshot replaces the TS-side contextProvider — over HTTP
  // we can't pass a function, so the caller passes a snapshot object
  // that witness hashes immediately. Subsequent answer calls supply a
  // fresh snapshot under `currentContext` to re-hash.
  app.post('/v1/decisions', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const required = ['kind', 'input', 'responseShape', 'authorizedRoles', 'surfaces'] as const;
    for (const key of required) {
      if (!(key in body)) return c.json({ error: 'missing_field', field: key }, 400);
    }
    try {
      const snapshot = body['contextSnapshot'];
      const id = await witness.askAsync(
        {
          kind: String(body['kind']),
          input: body['input'],
          responseShape: body['responseShape'] as Record<string, unknown>,
          authorizedRoles: (body['authorizedRoles'] as ReadonlyArray<string>) ?? [],
          surfaces: (body['surfaces'] as ReadonlyArray<string>) ?? [],
          timeoutMs: typeof body['timeoutMs'] === 'number' ? (body['timeoutMs'] as number) : undefined,
          contextProvider: snapshot !== undefined ? () => snapshot : undefined,
        },
        // No-op callback over HTTP; clients poll GET /decisions/:id.
        () => undefined,
      );
      return c.json({ decisionId: id }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'ask_failed', message: msg }, 400);
    }
  });

  // ---------------- get ----------------
  app.get('/v1/decisions/:id', async (c) => {
    const id = c.req.param('id');
    const row = await witness.getDecision(id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(row);
  });

  // ---------------- listOpen ----------------
  // GET /v1/decisions?authorized=role1,role2&status=open
  app.get('/v1/decisions', async (c) => {
    const authorized = c.req.query('authorized');
    if (!authorized) return c.json({ error: 'missing_query', field: 'authorized' }, 400);
    const roles = authorized.split(',').map((s) => s.trim()).filter(Boolean);
    const open = await witness.listOpen(roles);
    return c.json({ decisions: open });
  });

  // ---------------- answer ----------------
  // POST /v1/decisions/:id/answer
  // Body: { operator, answer, rationale, currentContext? }
  app.post('/v1/decisions/:id/answer', async (c) => {
    const id = c.req.param('id');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body['operator'] !== 'string' || !body['operator']) {
      return c.json({ error: 'missing_field', field: 'operator' }, 400);
    }
    if (typeof body['rationale'] !== 'string' || !body['rationale']) {
      return c.json({ error: 'missing_field', field: 'rationale' }, 400);
    }
    if (body['answer'] === undefined) {
      return c.json({ error: 'missing_field', field: 'answer' }, 400);
    }
    try {
      const result = await witness.answer({
        decisionId: id,
        operator: String(body['operator']),
        answer: body['answer'] as Record<string, unknown>,
        rationale: String(body['rationale']),
        currentContext: body['currentContext'],
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'answer_failed', message: msg }, 409);
    }
  });

  // ---------------- ack ----------------
  // POST /v1/decisions/:id/ack
  // Body: { surface, operator? }
  app.post('/v1/decisions/:id/ack', async (c) => {
    const id = c.req.param('id');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body['surface'] !== 'string' || !body['surface']) {
      return c.json({ error: 'missing_field', field: 'surface' }, 400);
    }
    const operator = typeof body['operator'] === 'string' ? (body['operator'] as string) : undefined;
    const result = await witness.acknowledgeDelivery({
      decisionId: id,
      surface: String(body['surface']),
      operator,
    });
    return c.json(result);
  });

  // ---------------- cancel ----------------
  // POST /v1/decisions/:id/cancel
  // Body: { operator, reason }
  app.post('/v1/decisions/:id/cancel', async (c) => {
    const id = c.req.param('id');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (typeof body['operator'] !== 'string' || !body['operator']) {
      return c.json({ error: 'missing_field', field: 'operator' }, 400);
    }
    if (typeof body['reason'] !== 'string' || !body['reason']) {
      return c.json({ error: 'missing_field', field: 'reason' }, 400);
    }
    try {
      const result = await witness.cancel({
        decisionId: id,
        operator: String(body['operator']),
        reason: String(body['reason']),
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'cancel_failed', message: msg }, 409);
    }
  });

  return app;
}

/**
 * Start a real HTTP server on the configured port (default 8787).
 * Used by `npm run server` and by Python integration tests that spin
 * up witness via `tsx`.
 */
export function startHttpServer(opts: HttpServerOptions & { port?: number } = {}): {
  app: Hono;
  close: () => Promise<void>;
} {
  const app = buildHttpServer(opts);
  const port = opts.port ?? Number(process.env.WITNESS_PORT ?? 8787);
  const server = serve({ fetch: app.fetch, port });
  return {
    app,
    close: () =>
      new Promise<void>((resolve) => {
        const s = server as unknown as { close: (cb: () => void) => void };
        s.close(() => resolve());
      }),
  };
}

// Auto-start when invoked directly: `npx tsx ts/server/http.ts`.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server/http.ts') === true;
if (isDirectInvocation) {
  const { app } = startHttpServer();
  void app;
  // eslint-disable-next-line no-console
  process.stderr.write(`witness http server listening on :${process.env.WITNESS_PORT ?? 8787}\n`);
}
