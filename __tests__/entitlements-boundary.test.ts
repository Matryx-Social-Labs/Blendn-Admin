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
 * Analytics would cost one request. So the paid writers are named only in
 * `lib/razorpay-webhook.ts`, and the admin's writers only in
 * `lib/billing-actions.ts`.
 *
 * "Touches the table" is any of the three shapes the client can be reached
 * by: `<client>.entitlements`, raw SQL naming it, or a destructuring
 * `{ entitlements } = <client>`. "Names a writer" is any mention, so an alias
 * or a re-export counts as surely as a call. The fixtures below hold each
 * shape (G13). Comments are stripped first: this docblock names them all.
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

/** `{ … } = client` with the braces matched, never `[^}]*` (playbook §2). */
function destructuresTable(code: string): boolean {
  for (const m of code.matchAll(/\}\s*=\s*(?:await\s+)?[A-Za-z_$][\w$]*\s*[;\n)]/g)) {
    let depth = 0
    for (let i = m.index; i >= 0; i--) {
      if (code[i] === "}") depth++
      else if (code[i] === "{" && --depth === 0) {
        if (/\bentitlements\b/.test(code.slice(i, m.index))) return true
        break
      }
    }
  }
  return false
}

export function touchesTable(code: string): boolean {
  return (
    /\.\s*entitlements\b/.test(code) ||
    /\b(?:from|into|update|join)\s+"?entitlements"?\b/i.test(code) ||
    destructuresTable(code)
  )
}

export const names = (code: string, name: string) => new RegExp(`\\b${name}\\b`).test(code)

const files = [...SEARCH.flatMap((d) => walk(join(ROOT, d))), join(ROOT, "server.ts")].map((f) => ({
  rel: relative(ROOT, f),
  code: stripComments(readFileSync(f, "utf8")),
}))

const naming = (name: string) =>
  files.filter((f) => f.rel !== "lib/entitlements.ts" && names(f.code, name)).map((f) => f.rel)

describe("the detectors (G13: each bypass shape is caught)", () => {
  it.each([
    ["the client's accessor", "await db.entitlements.findMany()"],
    ["a transaction's accessor", "tx . entitlements.update({})"],
    ["an alias of the accessor", "const e = db.entitlements; await e.count()"],
    ["raw SQL reading it", 'await db.$queryRaw`SELECT 1 FROM entitlements WHERE id = ${id}`'],
    ["raw SQL writing it", 'await db.$executeRaw`UPDATE "entitlements" SET expires_at = now()`'],
    ["a destructured accessor", "const { entitlements } = db\nawait entitlements.findMany()"],
    ["a nested destructuring", "const { entitlements: { findMany }, user } = db\n"],
  ])("catches %s", (_label, code) => {
    expect(touchesTable(code)).toBe(true)
  })

  it("does not cry wolf on code that only mentions the word", () => {
    expect(touchesTable('const label = "entitlements are paid"')).toBe(false)
    expect(touchesTable("const { entitlementsCount } = stats\n")).toBe(false)
  })

  it("treats an alias or an import of a writer as naming it", () => {
    expect(names("const grant = recordPaidEntitlement", "recordPaidEntitlement")).toBe(true)
    expect(names("import { recordPaidEntitlement as r } from './entitlements'", "recordPaidEntitlement")).toBe(true)
    expect(names("recordPaidEntitlementLater()", "recordPaidEntitlement")).toBe(false)
  })
})

describe("entitlements are read and written in one place", () => {
  it("scans the tree at all", () => {
    const rels = files.map((f) => f.rel)
    expect(rels).toContain("lib/entitlements.ts")
    expect(rels).toContain("lib/razorpay-webhook.ts")
  })

  it("only lib/entitlements.ts touches the table", () => {
    expect(files.filter((f) => touchesTable(f.code)).map((f) => f.rel)).toEqual(["lib/entitlements.ts"])
  })

  it("a paid entitlement is written by the webhook and nothing else", () => {
    expect(naming("recordPaidEntitlement")).toEqual(["lib/razorpay-webhook.ts"])
    expect(naming("endPaidEntitlement")).toEqual(["lib/razorpay-webhook.ts"])
  })

  it("grants, their ending and an admin's revocation come only from the admin's actions; a transfer's end only from the transfer", () => {
    expect(naming("grantEntitlement")).toEqual(["lib/billing-actions.ts"])
    expect(naming("endGrants")).toEqual(["lib/billing-actions.ts"])
    expect(naming("revokePaid")).toEqual(["lib/billing-actions.ts"])
    expect(naming("revokePaidByRefs")).toEqual(["lib/subscription-cancel.ts"])
  })
})
