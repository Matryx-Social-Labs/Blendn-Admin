import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative, resolve } from "path"

/**
 * No mobile endpoint may return a trust signal to another user.
 *
 * This is a safety constraint, not a preference, and it is the kind that erodes
 * quietly — someone wants a "verified" badge, or a "4.8★" on a match card, and
 * each step is individually reasonable.
 *
 * The person most likely to rate someone badly is the person who felt least safe
 * with them. Surface that rating and you have told the man that the woman who
 * met him rated him down, at an event where he knows who she is and may still be
 * in the room. The feature meant to protect her becomes what exposes her.
 *
 * So the rule is absolute and mechanical: nothing under `app/api/mobile`
 * references the trust module or the ratings table. Moderation reads it through
 * the dashboard, where the audience is staff.
 *
 * If this test fails, the fix is almost never to add an exception.
 */

const ROOT = resolve(__dirname, "..")
const MOBILE_API = join(ROOT, "app/api/mobile")

/** Reading peer_ratings to decide what someone may still rate is fine. */
const ALLOWED = new Set(["app/api/mobile/events/[eventId]/peer-ratings/route.ts"])

const FORBIDDEN = /getTrustSignal|trustBand|TrustSignal|peer_ratings\.(findMany|findFirst|aggregate|groupBy|count)/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("the trust signal never reaches an attendee", () => {
  it("is not referenced by any mobile endpoint", () => {
    const offenders = walk(MOBILE_API)
      .filter((f) => !ALLOWED.has(relative(ROOT, f)))
      .filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))

    // Guards the guard: an empty walk would pass vacuously.
    expect(walk(MOBILE_API).length).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })

  it("the rating endpoint tells the rater nothing about the person rated", () => {
    // Returning the subject's average, band, or how many others reported them
    // would leak the same information one request at a time.
    const src = readFileSync(
      join(ROOT, "app/api/mobile/events/[eventId]/peer-ratings/route.ts"),
      "utf8"
    )
    const responses = [...src.matchAll(/successResponse\(([^)]*)\)/g)].map((m) => m[1])
    expect(responses.length).toBeGreaterThan(0)
    for (const body of responses) {
      expect(body).not.toMatch(/trust|average|band|issues|rating[sS]|score/)
    }
  })
})
