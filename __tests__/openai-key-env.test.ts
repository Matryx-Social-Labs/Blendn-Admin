/*
 * SCRUM-1159: production runs the model checks, so it refuses to boot without
 * OPENAI_API_KEY. Gated on the Railway name, never NODE_ENV: the
 * CI e2e lane boots NODE_ENV=production with no key and must keep booting.
 */
import { openaiKeyProblem, validateEnv } from "@/lib/env"

const BASE = {
  DATABASE_URL: "postgresql://x",
  NEXTAUTH_URL: "http://localhost:3000",
  NEXTAUTH_SECRET: "x".repeat(32),
  MOBILE_JWT_SECRET: "y".repeat(32),
}

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function withEnv(extra: Record<string, string | undefined>) {
  process.env = { ...saved, ...BASE, ...extra } as NodeJS.ProcessEnv
}

describe("openaiKeyProblem", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "  "],
  ])("refuses production with the key %s, naming the variable", (_label, key) => {
    expect(openaiKeyProblem(key, "production")).toMatch(/^OPENAI_API_KEY /)
  })

  it("says what is required and where to set it", () => {
    expect(openaiKeyProblem(undefined, "production")).toBe(
      "OPENAI_API_KEY is required in production: set it on the Railway production service"
    )
  })

  it("allows production with a key", () => {
    expect(openaiKeyProblem("sk-test", "production")).toBeNull()
  })

  it.each([
    ["staging", "staging"],
    ["no Railway environment (local, CI)", undefined],
  ])("allows %s with no key", (_label, name) => {
    expect(openaiKeyProblem(undefined, name)).toBeNull()
  })
})

describe("validateEnv", () => {
  it("refuses to boot on Railway production with no key", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "production", OPENAI_API_KEY: undefined })
    expect(() => validateEnv()).toThrow("Invalid environment variables")
  })

  it("boots on Railway production with a key", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "production", OPENAI_API_KEY: "sk-test" })
    expect(() => validateEnv()).not.toThrow()
  })

  it("boots the CI e2e lane's way: NODE_ENV=production, no Railway name, no key", () => {
    withEnv({ NODE_ENV: "production", RAILWAY_ENVIRONMENT_NAME: undefined, OPENAI_API_KEY: undefined })
    expect(() => validateEnv()).not.toThrow()
  })

  it("boots on staging with no key", () => {
    withEnv({ RAILWAY_ENVIRONMENT_NAME: "staging", OPENAI_API_KEY: undefined })
    expect(() => validateEnv()).not.toThrow()
  })
})
