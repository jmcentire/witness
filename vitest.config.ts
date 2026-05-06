import { defineConfig } from 'vitest/config';

// Witness V1 uses an in-memory store for tests by default. Real
// Postgres integration tests live in the consumer (Reeve) until a
// second consumer (scram) needs witness's own integration matrix.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Two-person + ACK tests use fake timers to deterministically
    // exercise the 60s fallback window without sleeping in real time.
    pool: 'forks',
  },
});
