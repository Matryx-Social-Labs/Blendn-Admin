import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * Blendn+ is asked about in a known list of places, and nowhere else
 * (step 11; TQ-A13: MN-G01, MN-G03, and MN-I07 — the never-sold list).
 *
 * The owner's ruling: Plus is staying live while you're here, your full night
 * history, partner perks and crew extras. It is NEVER who liked you, more than
 * the caps allow, seeing a venue without going live, a reveal bypass or
 * boosting. A rule like that rots one innocent `if (plus)` at a time, inside a
 * route nobody re-reads. So the files that may ask are listed here by name,
 * each with the feature it gates; a new one fails the build until somebody
 * adds it on purpose — and the never-sold routes can only ask by being added.
 *
 * "Asking" is naming the gate (`plusRequired`, `lockedNights`), naming the
 * status read (`livePlus`), or calling `hasEntitlement` for `plus` or
 * `night_pass`. Comments are stripped first: this docblock names them all.
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

export const asksForPlus = (code: string) =>
  /\b(plusRequired|plusRequiredForPing|plusGatedForPerson|lockedNights|livePlus)\b/.test(code) ||
  /\bhasEntitlement\s*\([^;]*?["'](plus|night_pass)["']/.test(code)

/** Every place Blendn+ is asked about, and what it gates there. */
const ALLOWED: Record<string, string> = {
  "lib/plus.ts": "the gate itself",
  "lib/entitlements.ts": "the table's one reader",
  "app/api/mobile/venues/[venueId]/live/route.ts": "stay live while I'm here",
  "app/api/mobile/events/[eventId]/presence/route.ts": "stay live: carrying the window",
  "app/api/mobile/me/attendance/route.ts": "night history beyond 3",
  "app/api/mobile/me/plus/route.ts": "the status the paywall polls",
  "lib/billing-actions.ts": "the admin's view of a person's Plus, beside their grant (SCRUM-583)",
}

describe("the detector", () => {
  it.each([
    ["the gate", "if (await plusRequired(userId, city)) return refuse()"],
    ["the history lock", "const n = await lockedNights(id, total)"],
    ["an entitlement check for Plus", 'await hasEntitlement({ kind: "user", id }, "plus")'],
    ["one for a Night Pass, spread over lines", "await hasEntitlement(\n  subject,\n  'night_pass',\n  {}\n)"],
  ])("catches %s", (_label, code) => {
    expect(asksForPlus(code)).toBe(true)
  })

  it("does not cry wolf on other products or words", () => {
    expect(asksForPlus('await hasEntitlement({ kind: "org", id }, "analytics")')).toBe(false)
    expect(asksForPlus('const label = "Blendn plus"')).toBe(false)
  })
})

describe("Blendn+ is asked about only where it is sold", () => {
  it("scans the tree at all", () => {
    expect(files.map((f) => f.rel)).toContain("app/api/mobile/venues/[venueId]/live/route.ts")
  })

  it("in exactly the listed files — never in a who-liked-you, cap, venue-view, reveal or boost path", () => {
    expect(files.filter((f) => asksForPlus(f.code)).map((f) => f.rel).sort()).toEqual(Object.keys(ALLOWED).sort())
  })

  it("is never sold through Razorpay: Razorpay's code and the price table name no Blendn+ product (MN-G03)", () => {
    // The admin's grant in lib/billing-actions.ts names "plus" and writes only source "grant"
    // (grantEntitlement); the database's CHECK refuses Plus from Razorpay whatever the code says.
    const money = files.filter((f) => /^lib\/(razorpay[^/]*|billing|billing-plans)\.ts$/.test(f.rel))
    expect(money.map((f) => f.rel).sort()).toEqual(["lib/billing-plans.ts", "lib/billing.ts", "lib/razorpay-webhook.ts", "lib/razorpay.ts"])
    for (const f of money) expect([f.rel, /["'](plus|night_pass)["']/.test(f.code)]).toEqual([f.rel, false])
  })
})
