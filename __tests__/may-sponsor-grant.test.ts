import { readFileSync } from "fs"
import { join } from "path"

/**
 * `may_sponsor` must have a writer, and the writer must be an admin.
 *
 * The flag shipped in #259 with **one reader and zero writers**. So the gate was
 * correct in the deny direction and no screen on the platform could turn it on:
 * a real paying sponsor could not be granted the capability by anybody, and the
 * commercial model the feature was built for was unsellable. Both directions
 * wrong at the same time.
 *
 * That is the same declared-but-unreachable pattern as `canSendSystemMessages`,
 * `canSendPushNotifications` and `likeAtEvent` — the fourth instance found in
 * this codebase. It ships green: typechecks, tests pass, nothing errors.
 *
 * Source assertions rather than a render, because what is being guarded is the
 * existence and shape of a writer, not the behaviour of a component.
 */

const ROOT = join(__dirname, "..")
const ACTIONS = readFileSync(join(ROOT, "lib", "onboarding-actions.ts"), "utf8")
const CONTROL = readFileSync(
  join(ROOT, "app", "dashboard", "organisations", "sponsor-control.tsx"),
  "utf8"
)
const PAGE = readFileSync(
  join(ROOT, "app", "dashboard", "organisations", "page.tsx"),
  "utf8"
)

describe("may_sponsor has a writer", () => {
  it("is written somewhere, not only read", () => {
    // The whole finding, in one assertion.
    expect(ACTIONS).toMatch(/may_sponsor:\s*maySponsor/)
  })

  it("is admin-only", () => {
    // The flag represents a commercial agreement. An organiser granting it to
    // themselves makes "sponsored" a styling choice rather than a claim that
    // somebody paid.
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function setOrganisationMaySponsor"))
    expect(fn).toMatch(/await requireAdmin\(\)/)
  })

  it("records why, both granting and revoking", () => {
    // The agreement lives outside this system; six months later the audit row
    // is the only record of which one.
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function setOrganisationMaySponsor"))
    expect(fn).toMatch(/reason[\s\S]*trim\(\)[\s\S]*length < 10/)
    expect(fn).toMatch(/action: maySponsor \? "organisation\.may_sponsor\.grant"/)
  })

  it("refuses to grant to an organisation that is not verified", () => {
    // Suspension is how an org is stopped. Handing it a paid capability in that
    // state is two controls contradicting each other, last click winning.
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function setOrganisationMaySponsor"))
    expect(fn).toMatch(/maySponsor && org\.status !== "verified"/)
  })
})

describe("the control is reachable and states what it does not do", () => {
  it("is mounted on the organisations screen", () => {
    // A writer nothing renders is the same bug one layer up.
    expect(PAGE).toMatch(/OrgSponsorControl/)
    expect(PAGE).toMatch(/maySponsor=\{org\.may_sponsor\}/)
  })

  it("is fed the real flag, not a default", () => {
    expect(ACTIONS).toMatch(/may_sponsor: o\.may_sponsor/)
  })

  it("tells the admin that revoking does not stop live placements", () => {
    /*
     * `may_sponsor` gates the WRITE path, not the scheduler. An admin who
     * revokes expecting the ads to stop, and finds they have not, has been
     * misled by the control rather than by the code.
     */
    expect(CONTROL).toMatch(/not.*stopped|Placements\s+already running/i)
  })
})
