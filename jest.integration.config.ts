import type { Config } from "jest"

/**
 * Integration tests — these run against a REAL Postgres.
 *
 * The unit suite mocks `@/lib/db` everywhere, which means it cannot detect a
 * Prisma upgrade that changes query behaviour: every test would stay green
 * while every query broke. These tests close that gap by executing real
 * queries against the `postgres:16` service CI already provisions and pushes
 * the schema into.
 *
 * Locally: `DATABASE_URL=... npm run test:integration`
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__/integration"],
  testMatch: ["**/*.itest.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    /*
     * `jose` is ESM-only and `transform` covers TypeScript, not `node_modules`,
     * so any suite importing `lib/mobile-auth.ts` for real dies at parse time.
     * The unit runner never hits this because it mocks that module wholesale.
     * See the stub for why it throws rather than returning a fake verification.
     */
    "^jose$": "<rootDir>/__tests__/integration/jose-stub.ts",
  },
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
  // Real DB work is slower than mocked unit tests, and they share one database,
  // so run serially to keep truncation between suites deterministic.
  maxWorkers: 1,
  testTimeout: 30_000,
  // The pg pool closes gracefully in closeDb(), but not within the one second
  // jest waits before warning. Verified with --detectOpenHandles: it reports
  // NO leaked handles and exits cleanly, so this is jest being impatient about
  // a clean shutdown rather than a leak being papered over. Without it CI
  // prints a scary warning on every green run.
  forceExit: true,
}

export default config
