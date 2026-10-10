import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

/**
 * One writer of the Tier B facts (step 10 review H1 / the rate-limit scan).
 *
 * Languages, home state, sign and field of work are limited to three changes a
 * day and stamped on every change (lib/tier-b.ts) — and only the profile route
 * does both. A second path that wrote them (a PATCH, an onboarding shortcut, a
 * preferences route) would change them unstamped and uncounted, which is the
 * oracle back again. So every write of `profiles` outside the allowed files
 * must not name a Tier B column. Scripts (seeds) are not runtime and are out.
 */

const ROOT = join(__dirname, "..")
const TIER_B = /\b(languages|home_state|sun_sign|sign_system|work_field|tier_b_changed_at|tier_b_changes)\b\??\s*[:=]/
const WRITES_PROFILES = /\b(?:db|tx|client)\.profiles\.(?:create|createMany|update|updateMany|upsert)\(|UPDATE\s+"?profiles"?/i

/** The writer, the counter, and the erasure that clears them. */
const ALLOWED = new Set([
  "app/api/mobile/profiles/[userId]/route.ts",
  "lib/tier-b.ts",
  "app/api/mobile/account/route.ts",
])

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "")

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") sources(full, acc)
    } else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

const offends = (src: string) => WRITES_PROFILES.test(src) && TIER_B.test(src)

describe("Tier B is written in one place (H1)", () => {
  it("sees a planted second writer (control)", () => {
    expect(offends('await db.profiles.update({ where: { id }, data: { home_state: "kerala" } })')).toBe(true)
    expect(offends('await tx.$executeRaw`UPDATE profiles SET work_field = ${x}`')).toBe(true) // raw SQL too
    expect(offends('await db.profiles.update({ where: { id }, data: { bio: "x" } })')).toBe(false)
  })

  it("no file but the profile route, the counter and the erasure writes it", () => {
    const files = ["app", "lib"].flatMap((d) => sources(join(ROOT, d)))
    const found = files
      .map((f) => ({ file: relative(ROOT, f), src: strip(readFileSync(f, "utf8")) }))
      .filter(({ file, src }) => !ALLOWED.has(file) && offends(src))
      .map(({ file }) => file)
    expect(found).toEqual([])
  })

  it("the profile route stamps and counts every change it writes", () => {
    const route = strip(readFileSync(join(ROOT, "app/api/mobile/profiles/[userId]/route.ts"), "utf8"))
    expect(route).toMatch(/changesTierB\(/)
    expect(route).toMatch(/claimTierBChange\(userId\)/)
    expect(route).toMatch(/tier_b_changed_at: new Date\(\)/)
  })
})
