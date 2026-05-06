// Public surface for @stack/witness.
//
// V1: TypeScript library + thin HTTP server.
//   - Library: `import { createWitness } from '@stack/witness';`
//   - Server: `import { buildHttpServer } from '@stack/witness/server';`
//
// Consumers in TypeScript (Reeve operator queue, future TS clients)
// embed the library directly. Consumers in Python (scram, baton,
// sentinel) hit the HTTP server and use the @stack/witness-client
// Python package.

export type {
  AnswerResult,
  Approval,
  AskArgs,
  CancelResult,
  Decision,
  DecisionId,
  DecisionStatus,
  FallbackHook,
  SurfaceAck,
  SurfaceDispatcher,
  SurfaceName,
  TesseraClient,
  TesseraEvent,
  TwoPersonPolicy,
  TwoPersonPolicyMap,
  WitnessConfig,
} from './types.ts';

export { WitnessInstance } from './api.ts';
export type { DecisionStore, DecisionQuery, DecisionUpdate } from './persistence.ts';
export { setStore, getStore, __resetInMemoryStore } from './persistence.ts';
export { contextHash, canonicalJson, contextStillMatches } from './two-person.ts';
export {
  inboxSurface,
  pagerdutySurfaceStub,
  slackSurfaceStub,
  emailSurfaceStub,
  smsSurfaceStub,
  defaultFallbackHook,
} from './surfaces.ts';
export {
  NoopTesseraClient,
  StdoutTesseraClient,
  InMemoryTesseraClient,
  defaultTesseraClient,
  buildEvent,
} from './tessera.ts';
export { setLogger } from './logger.ts';
export type { Logger } from './logger.ts';

import { WitnessInstance } from './api.ts';
import type { WitnessConfig } from './types.ts';

/**
 * Build a witness instance with the given configuration. Callers
 * typically build one per process and reuse it. The default
 * configuration ships an in-memory store + inbox surface + stdout
 * Tessera; production consumers swap each via WitnessConfig.
 */
export function createWitness(config: WitnessConfig = {}): WitnessInstance {
  return new WitnessInstance(config);
}
