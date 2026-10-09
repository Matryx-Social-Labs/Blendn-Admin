import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * MN-G01: entitlements have one door each way.
 *
 * `lib/entitlements.ts` is the only module that reads or writes the table, so
 * every gate goes through `hasEntitlement` and there is no second, slightly
 * different answer to "may they use this" (the way authorization once had two,
 * `authz-scoping-boundary.test.ts`).
 *
 * And a paid row is written by the payment provider's webhook only. The
 * browser comes back from Razorpay Checkout saying "paid", and that return is
 * a URL anyone can type: if a server action could write a paid entitlement,
 * Analytics would cost one request. So `recordPaidEntitlement` and
 * `endPaidEntitlement` have exactly one caller, `lib/razorpay-webhook.ts`, and
 * an admin's grant has exactly one, `lib/billing-actions.ts`.
 *
 * Comments are stripped first: this docblock names the functions it guards.
 */

const ROOT = join(__dirname, "..")
const SEARCH = ["app", "components", "lib", "scripts"]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const files = [...SEARCH.flatMap((d) => walk(join(ROOT, d))), join(ROOT, "server.ts")].map((f) => ({
  rel: relative(ROOT, f),
  code: stripComments(readFileSync(f, "utf8")),
}))

/** `db.entitlements.…`, `tx.entitlements.…`, `prisma.entitlements…`. */
const TABLE_ACCESS = /\b\w+\s*\.\s*entitlements\s*\./

const callersOf = (name: string) =>
  files
    .filter((f) => f.rel !== "lib/entitlements.ts")
    .filter((f) => new RegExp(`\\b${name}\\s*\\(`).test(f.code))
    .map((f) => f.rel)

describe("entitlements are read and written in one place", () => {
  it("scans the tree at all", () => {
    const names = files.map((f) => f.rel)
    expect(names).toContain("lib/entitlements.ts")
    expect(names).toContain("lib/razorpay-webhook.ts")
  })

  it("only lib/entitlements.ts touches the table", () => {
    const touching = files.filter((f) => TABLE_ACCESS.test(f.code)).map((f) => f.rel)
    expect(touching).toEqual(["lib/entitlements.ts"])
  })

  it("a paid entitlement is written by the webhook and nothing else", () => {
    expect(callersOf("recordPaidEntitlement")).toEqual(["lib/razorpay-webhook.ts"])
    expect(callersOf("endPaidEntitlement")).toEqual(["lib/razorpay-webhook.ts"])
  })

  it("a grant is given and ended only by the admin's actions", () => {
    expect(callersOf("grantEntitlement")).toEqual(["lib/billing-actions.ts"])
    expect(callersOf("endGrant")).toEqual(["lib/billing-actions.ts"])
  })
})
