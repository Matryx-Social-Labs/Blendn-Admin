import { readFileSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * SCRUM-651: every admin grant, end and revoke in `lib/billing-actions.ts`
 * passes through `requireAdminWithinLimit`, the per-admin ceiling on money
 * changes. `grantPlus` and `endPlusGrant` used the bare `requireAdmin` and were
 * the only entitlement writers with no ceiling. SCRUM-900: the same for the
 * sponsor charge ledger, `lib/charge-actions.ts`, where every exported action
 * but a `get…` read writes or reaches Razorpay.
 *
 * "Writer" is by name: in billing-actions an exported async function starting
 * `grant`, `end` or `revoke`; in charge-actions anything not starting `get`. A new one that calls the bare guard fails here until it is fixed.
 * The fixtures at the bottom hold the shapes this must catch and the one it
 * must not.
 */

const WRITER = /^(grant|end|revoke)[A-Z]/
const CHARGE_WRITER = /^(?!get[A-Z])/

/** Exported async functions (declarations and `const x = async`) with their bodies, comments stripped. */
export function exportedFunctions(source: string): Array<{ name: string; body: string }> {
  const code = stripComments(source)
  const heads = [...code.matchAll(/export (?:async function (\w+)\(|const (\w+) = async\b)/g)]
  return heads.map((m, i) => ({ name: m[1] ?? m[2], body: code.slice(m.index, heads[i + 1]?.index ?? code.length) }))
}

/** Names of writers whose body does not call the limited guard, or calls the bare one. */
export function unlimitedWriters(source: string, isWriter: RegExp = WRITER): string[] {
  return exportedFunctions(source)
    .filter((f) => isWriter.test(f.name))
    .filter((f) => !/\brequireAdminWithinLimit\(\)/.test(f.body) || /\brequireAdmin\(\)/.test(f.body))
    .map((f) => f.name)
}

describe("admin money actions are rate limited per admin (SCRUM-651)", () => {
  const source = readFileSync(join(__dirname, "..", "lib/billing-actions.ts"), "utf8")

  it("finds the writers it is meant to guard", () => {
    const names = exportedFunctions(source).map((f) => f.name).filter((n) => WRITER.test(n))
    expect(names).toEqual(expect.arrayContaining(["grantAnalytics", "grantVenuePro", "grantPlus", "endPlusGrant", "revokePaidEntitlement"]))
  })

  it("no grant, end or revoke uses the bare requireAdmin", () => {
    expect(unlimitedWriters(source)).toEqual([])
  })

  it("no charge-ledger action but a read uses the bare requireAdmin (SCRUM-900)", () => {
    const charges = readFileSync(join(__dirname, "..", "lib/charge-actions.ts"), "utf8")
    const names = exportedFunctions(charges).map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(["getChargeLedger", "pricePlacement", "advanceCharge", "sendPaymentLink"]))
    expect(unlimitedWriters(charges, CHARGE_WRITER)).toEqual([])
  })

  describe("fixtures", () => {
    it("flags a writer that calls the bare guard", () => {
      expect(unlimitedWriters("export async function grantX() {\n  const a = await requireAdmin()\n}")).toEqual(["grantX"])
    })
    it("flags a writer that calls no guard", () => {
      expect(unlimitedWriters("export async function endY() {\n  await db.x()\n}")).toEqual(["endY"])
    })
    it("sees a writer declared as an exported async arrow", () => {
      expect(unlimitedWriters("export const grantQ = async () => {\n  await requireAdmin()\n}")).toEqual(["grantQ"])
    })
    it("passes a limited writer and ignores a reader", () => {
      const ok = "export async function grantZ() {\n  await requireAdminWithinLimit()\n}\nexport async function personPlus() {\n  await requireAdmin()\n}"
      expect(unlimitedWriters(ok)).toEqual([])
    })
  })
})
