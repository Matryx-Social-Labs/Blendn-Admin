import { readFileSync } from "fs"
import { join } from "path"

/**
 * A sponsor can apply, be approved, and actually sponsor.
 *
 * Three separate places had to know about the role, and each fails differently
 * when it does not:
 *
 *   the apply schema     a sponsor cannot apply at all — zod rejects the value
 *   the approval         the org is created without `may_sponsor`, so the
 *                        account is "approved" and still cannot do the one
 *                        thing it applied for, with nothing on screen saying why
 *   the review queue     the application renders as "Organiser", so an admin
 *                        grants placement rights believing they approved a host
 *
 * The middle one is the interesting failure: it is not an error, it is a
 * working account that quietly cannot work.
 */

const ROOT = join(__dirname, "..")
const APPLY = readFileSync(
  join(ROOT, "app", "api", "onboarding", "apply", "route.ts"),
  "utf8"
)
const ACTIONS = readFileSync(join(ROOT, "lib", "onboarding-actions.ts"), "utf8")
const QUEUE = readFileSync(
  join(ROOT, "app", "dashboard", "onboarding", "queue.tsx"),
  "utf8"
)

describe("a sponsor can apply", () => {
  it("is an accepted requested_role", () => {
    expect(APPLY).toMatch(/z\.enum\(\["organizer", "venue_owner", "sponsor"\]\)/)
  })

  it("keeps organizer as the default, so the public form is unchanged", () => {
    expect(APPLY).toMatch(/\.default\("organizer"\)/)
  })
})

describe("approval grants the capability it approved", () => {
  it("sets may_sponsor from the requested role, in the same transaction", () => {
    /*
     * Approving and then requiring a separate grant produces an account that is
     * approved and cannot sponsor. The admin thinks they are done; the sponsor
     * cannot do the one thing they applied for.
     *
     * An admin who wants the account without the capability revokes it
     * afterwards, which records a reason — the rarer case takes the extra step.
     */
    expect(ACTIONS).toMatch(/may_sponsor: request\.requested_role === "sponsor"/)
  })

  it("carries sponsor through the role union", () => {
    expect(ACTIONS).toMatch(
      /requested_role: "organizer" \| "venue_owner" \| "sponsor"/
    )
  })
})

describe("the reviewer can see what they are approving", () => {
  it("labels roles from an exhaustive map, not a ternary", () => {
    /*
     * The old `venue_owner ? "Venue owner" : "Organiser"` did not error when a
     * third role appeared — it silently mislabelled it, which is the worst
     * possible behaviour on the screen where placement rights are granted.
     */
    expect(QUEUE).toMatch(/const ROLE_LABEL: Record<OnboardingRow\["requested_role"\], string>/)
    expect(QUEUE).toMatch(/sponsor: "Sponsor"/)
    expect(QUEUE).not.toMatch(/requested_role === "venue_owner" \? "Venue owner" : "Organiser"/)
  })

  it("types the map against the union, so a new role is a compile error", () => {
    // A plain `Record<string, string>` would accept a missing key and render
    // `undefined` in the badge.
    expect(QUEUE).toMatch(/Record<OnboardingRow\["requested_role"\], string>/)
  })
})
