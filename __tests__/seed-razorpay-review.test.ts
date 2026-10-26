/**
 * The Razorpay reviewer's account may be written to staging and a local
 * database freely, and to production only when the owner passes
 * `--production` — refused before a single query. Its role is never
 * `app_admin`. The writes themselves are `integration/seed-razorpay-review.itest.ts`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import type { PrismaClient } from "@prisma/client"

import {
  REVIEW_ROLE,
  environmentRefusal,
  ensureRazorpayReviewAccount,
  parseFlags,
  removeRazorpayReviewAccount,
  worldFrom,
} from "../scripts/seed-razorpay-review"

const touched: string[] = []
// Any property read on this "client" is a query that should never have run.
const db = new Proxy({}, { get: (_t, prop) => (touched.push(String(prop)), () => Promise.resolve(null)) }) as unknown as PrismaClient

const PRODUCTION = { RAILWAY_ENVIRONMENT_NAME: "production", DATABASE_URL: "postgresql://u:p@db.internal:5432/railway" }
const LAPTOP_TO_PROD = { DATABASE_URL: "postgresql://u:p@shuttle.proxy.rlwy.net:41234/railway" }
const STAGING = { RAILWAY_ENVIRONMENT_NAME: "staging", DATABASE_URL: "postgresql://u:p@db.internal:5432/railway" }
const LOCAL = { DATABASE_URL: "postgresql://postgres:postgres@localhost:55433/blendn_test" }
const PASSWORD = "Rzp-Review-Correct-Horse-26"
const world = worldFrom({})

beforeEach(() => {
  touched.length = 0
})

describe("environmentRefusal", () => {
  it("allows staging and a local database without any flag", () => {
    expect(environmentRefusal(STAGING, { production: false })).toBeNull()
    expect(environmentRefusal(LOCAL, { production: false })).toBeNull()
  })

  it("refuses production, and a remote URL in a laptop shell, without --production", () => {
    expect(environmentRefusal(PRODUCTION, { production: false })).toMatch(/production.*--production/)
    expect(environmentRefusal(LAPTOP_TO_PROD, { production: false })).toMatch(/shuttle\.proxy\.rlwy\.net/)
  })

  it("allows production with --production", () => {
    expect(environmentRefusal(PRODUCTION, { production: true })).toBeNull()
    expect(environmentRefusal(LAPTOP_TO_PROD, { production: true })).toBeNull()
  })
})

describe("refused before any query", () => {
  it.each([
    ["production without --production", PRODUCTION],
    ["a remote database without --production", LAPTOP_TO_PROD],
  ])("%s: apply and remove both throw and touch nothing", async (_label, env) => {
    await expect(ensureRazorpayReviewAccount(db, PASSWORD, world, env, { production: false })).rejects.toThrow(/REFUSING/)
    await expect(removeRazorpayReviewAccount(db, world, env, { production: false })).rejects.toThrow(/REFUSING/)
    expect(touched).toEqual([])
  })

  it("production with --production but no password: refused, nothing touched", async () => {
    await expect(ensureRazorpayReviewAccount(db, "", world, PRODUCTION, { production: true })).rejects.toThrow(
      /RAZORPAY_REVIEW_PASSWORD is not set/
    )
    expect(touched).toEqual([])
  })

  it("a password the product would refuse: refused, nothing touched", async () => {
    await expect(ensureRazorpayReviewAccount(db, "short", world, LOCAL, { production: false })).rejects.toThrow(/refused/)
    expect(touched).toEqual([])
  })
})

describe("never an admin", () => {
  it("gives the organizer role, and no role is written anywhere but from that constant", () => {
    expect(REVIEW_ROLE).toBe("organizer")
    const source = readFileSync(path.join(__dirname, "../scripts/seed-razorpay-review.ts"), "utf8")
    expect(source).not.toMatch(/role:\s*"app_admin"/)
    const roleWrites = source.match(/\brole:\s*[^,}\n]+/g) ?? []
    // The user's role, twice (create and repair), and the membership's owner role.
    expect(roleWrites.filter((w) => !/REVIEW_ROLE|"owner"|true/.test(w))).toEqual([])
  })
})

describe("flags and world", () => {
  it("is a dry run unless --apply", () => {
    expect(parseFlags([])).toEqual({ apply: false, remove: false, production: false })
    expect(parseFlags(["--remove", "--apply", "--production"])).toEqual({ apply: true, remove: true, production: true })
  })

  it("uses RAZORPAY_REVIEW_EMAIL when set, lower-cased", () => {
    expect(worldFrom({}).email).toBe("razorpay.review@blendn.app")
    expect(worldFrom({ RAZORPAY_REVIEW_EMAIL: " Reviewer@Example.com " }).email).toBe("reviewer@example.com")
  })
})
