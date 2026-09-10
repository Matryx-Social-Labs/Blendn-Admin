import type { Config } from "jest"

/*
 * Every run is in UTC, so a date assertion means the same thing everywhere.
 *
 * Nothing pinned this: tests ran in whatever timezone the machine had, so a
 * suite could be green on a laptop in Europe/Berlin and red in CI purely
 * because a local date rolled over. That is not hypothetical here — a
 * `date_of_birth` was once read as off by one for exactly this reason, and the
 * answer was the driver rendering a `date` column in Berlin.
 *
 * UTC rather than the product's Asia/Kolkata: CI already runs in UTC, so this
 * makes local runs match CI rather than introducing a third timezone.
 */
process.env.TZ = "UTC"

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  // Integration tests need a live Postgres, so they are not part of the default
  // run. `npm run test:integration` uses jest.integration.config.ts instead.
  // `__tests__/support/` holds helpers shared between suites. Jest's default
  // testMatch treats every file under `__tests__` as a spec, so without this a
  // helper module fails the run with "must contain at least one test".
  testPathIgnorePatterns: ["<rootDir>/__tests__/integration/", "<rootDir>/__tests__/support/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
}

export default config
