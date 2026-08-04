import type { Config } from "jest"

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  // Integration tests need a live Postgres, so they are not part of the default
  // run. `npm run test:integration` uses jest.integration.config.ts instead.
  testPathIgnorePatterns: ["<rootDir>/__tests__/integration/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
}

export default config
