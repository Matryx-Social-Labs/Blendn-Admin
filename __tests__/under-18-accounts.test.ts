/**
 * `scripts/under-18-accounts.ts` runs against a local database freely, and
 * against Railway staging or production only when the environment is named
 * twice: by `railway run` and by `--environment`. Refused before a query.
 * The writes themselves are `integration/under-18-accounts.itest.ts`.
 */
// The erasure (sockets, auth, storage) is not this file's subject; the itest runs it for real.
jest.mock("@/lib/account-erasure", () => ({ eraseAccount: jest.fn() }))

import { environmentRefusal, parseArgs } from "../scripts/under-18-accounts"

const LOCAL = { DATABASE_URL: "postgresql://postgres:postgres@localhost:55433/blendn_test" }
const STAGING = { RAILWAY_ENVIRONMENT_NAME: "staging", DATABASE_URL: "postgresql://u:p@shuttle.proxy.rlwy.net:41234/railway" }
const PRODUCTION = { RAILWAY_ENVIRONMENT_NAME: "production", DATABASE_URL: "postgresql://u:p@db.internal:5432/railway" }
const LAPTOP_TO_REMOTE = { DATABASE_URL: "postgresql://u:p@shuttle.proxy.rlwy.net:41234/railway" }

describe("environmentRefusal", () => {
  it("allows a local database with no environment named", () => {
    expect(environmentRefusal(LOCAL, undefined)).toBeNull()
    expect(environmentRefusal({ DATABASE_URL: "postgresql://p@127.0.0.1:5432/x" }, undefined)).toBeNull()
  })

  it("allows staging and production only when --environment names the same Railway environment", () => {
    expect(environmentRefusal(STAGING, "staging")).toBeNull()
    expect(environmentRefusal(PRODUCTION, "production")).toBeNull()
    expect(environmentRefusal(STAGING, undefined)).toMatch(/--environment/)
    expect(environmentRefusal(PRODUCTION, undefined)).toMatch(/--environment/)
    expect(environmentRefusal(PRODUCTION, "staging")).toMatch(/production/)
  })

  it("refuses a remote database reached without railway run, whatever the flag says", () => {
    expect(environmentRefusal(LAPTOP_TO_REMOTE, undefined)).toMatch(/shuttle\.proxy\.rlwy\.net/)
    expect(environmentRefusal(LAPTOP_TO_REMOTE, "production")).not.toBeNull()
  })

  it("refuses a Railway environment that is neither staging nor production", () => {
    expect(environmentRefusal({ ...STAGING, RAILWAY_ENVIRONMENT_NAME: "pr-1234" }, "pr-1234")).not.toBeNull()
  })

  it("refuses a local-looking URL whose ?host= points elsewhere (pg reads the last host)", () => {
    expect(environmentRefusal({ DATABASE_URL: "postgresql://u:p@localhost:5432/x?host=db.example.com" }, undefined)).not.toBeNull()
  })

  it("refuses a missing or broken DATABASE_URL", () => {
    expect(environmentRefusal({}, undefined)).not.toBeNull()
    expect(environmentRefusal({ DATABASE_URL: "not a url" }, undefined)).not.toBeNull()
  })
})

describe("parseArgs", () => {
  const ID = "3f1d2c4b-0000-4000-8000-000000000001"

  it("is a dry run by default and writes only with --apply", () => {
    expect(parseArgs([])).toEqual({ mode: "dry-run" })
    expect(parseArgs(["--apply"])).toEqual({ mode: "apply" })
    expect(parseArgs(["--apply", "--environment", "staging"])).toEqual({ mode: "apply", environment: "staging" })
  })

  it("takes a correction as an id, a date and the staff address making it", () => {
    expect(parseArgs(["--correct", ID, "1990-04-02", "--by", "ops@matrixsociallabs.com"])).toEqual({
      mode: "correct",
      userId: ID,
      dateOfBirth: "1990-04-02",
      by: "ops@matrixsociallabs.com",
    })
  })

  it("refuses a correction with no staff address, or one off the company domain", () => {
    expect(parseArgs(["--correct", ID, "1990-04-02"])).toMatch(/--by/)
    expect(parseArgs(["--correct", ID, "1990-04-02", "--by", "someone@gmail.com"])).toMatch(/--by/)
  })

  it("refuses anything it does not know, and --apply with --correct", () => {
    expect(parseArgs(["--delete"])).toMatch(/usage/)
    expect(parseArgs(["--apply", "--correct", ID, "1990-04-02", "--by", "ops@matrixsociallabs.com"])).toMatch(/usage/)
    expect(parseArgs(["--correct", ID])).toMatch(/usage/)
    expect(parseArgs(["--environment"])).toMatch(/usage/)
  })
})
