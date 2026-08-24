import type { Config } from "jest"

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
