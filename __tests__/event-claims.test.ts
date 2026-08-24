import { readFileSync } from "fs"
import { join } from "path"
import { eventHost, PLATFORM_HOST } from "@/lib/event-host"

/**
 * The claim is the acquisition: a curated event sits in a city doing its job,
 * the real organiser finds it, proves it, and takes it over — arriving on the
 * platform with an event that already has attendees.
 */

const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const ACTIONS = "lib/event-claim-actions.ts"

describe("filing a claim", () => {
  const src = code(ACTIONS)

  it("does not require an account", () => {
    /*
     * Most claims arrive from somebody with no account — that is *why* the
     * event was curated. Requiring a login here would put a signup wall in
     * front of the acquisition funnel.
     *
     * Safe because filing proves nothing and grants nothing; a human reads it.
     */
    const fileFn = /export async function fileEventClaim[\s\S]*?\n\}/.exec(src)
    expect(fileFn).not.toBeNull()
    expect(fileFn![0]).not.toMatch(/getAuth\(\)/)
  })

  it("insists on exactly one route in", () => {
    // A claim with neither has nothing to approve into; a claim with both is
    // two answers to one question. The DB has a CHECK; this is the message.
    expect(src).toMatch(/Boolean\(input\.orgId\) === Boolean\(input\.onboardingId\)/)
  })

  it("uses the same refusal gate the read path uses", () => {
    /*
     * So the form and the submit cannot disagree — which is the failure the
     * chat write path spent a whole workstream on: GET said yes, POST said no.
     */
    expect(src).toMatch(/claimRefusal\(event\)/)
  })

  it("counts prior claims rather than upserting over them", () => {
    expect(src).toMatch(/db\.event_claims\.count\(\{ where: \{ event_id: event\.id \} \}\)/)
    expect(src).not.toMatch(/event_claims\.upsert/)
  })

  it("reads DNS-verified domains, not merely matching addresses", () => {
    /*
     * Decision 3a. `organisation_domains` stores DNS-TXT-verified, apex-only
     * domains with a global unique — so a domain check can mean *this org
     * proved control*, which is much harder to fake for the same effort.
     */
    expect(src).toMatch(/organisation_domains\.findMany/)
    expect(src).toMatch(/verified_at: \{ not: null \}/)
  })
})

describe("deciding one", () => {
  const src = code(ACTIONS)

  it("is app_admin only", () => {
    expect(src).toMatch(/session\?\.user\?\.role !== "app_admin"/)
  })

  it("re-checks claimability at decision time, not only at filing", () => {
    /*
     * A claim can sit in the queue for days. In that time the event can start,
     * or somebody else's claim can be approved. Trusting the filing-time check
     * is how an approval lands in the middle of a live event.
     */
    const decide = src.slice(src.indexOf("export async function decideEventClaim"))
    expect(decide).toMatch(/claimRefusal\(claim\.event\)/)
  })

  it("approves with one column write", () => {
    /*
     * Every screen unlocks from this, because `eventPermissions` already reads
     * `organizer_org_id`. That is the strongest argument for representing
     * curation this way rather than with a separate table.
     */
    expect(src).toMatch(/organizer_org_id: claim\.org_id, claimed_at: new Date\(\)/)
  })

  it("never rewrites organizer_id", () => {
    /*
     * CLAUDE.md: it records who CREATED the row, and after a claim that is
     * still true — the platform did. Rewriting it destroys the only record that
     * this event was curated rather than filed, which is the fact a later
     * dispute turns on.
     */
    const decide = src.slice(src.indexOf("export async function decideEventClaim"))
    expect(decide).not.toMatch(/organizer_id:/)
  })

  it("supersedes the losers rather than declining them", () => {
    /*
     * `declined` is a judgement about the claimant and reaches them as one. A
     * claim that lost a race deserves a different word, and a reviewer reading
     * the queue later needs to tell the two apart.
     */
    expect(src).toMatch(/status: "superseded"/)
  })

  it("refuses to approve a claim with no organisation to hand it to", () => {
    expect(src).toMatch(/Approve the onboarding request first/)
  })

  it("makes the write and the supersede one transaction", () => {
    // Half of this is worse than none: an event handed over while three other
    // claims still say pending is a queue that contradicts the event.
    expect(src).toMatch(/db\.\$transaction\(async \(tx\) => \{/)
  })
})

describe("who to show as the host", () => {
  it("shows the owning organisation once a claim lands", () => {
    expect(eventHost({
      curated_at: new Date(),
      organizer_org: { display_name: "The Humming Tree" },
      organizer: { name: "An Admin" },
    })).toEqual({ name: "The Humming Tree", isPlatform: false })
  })

  it("never shows the curating admin's name on a public card", () => {
    /*
     * The admin who ran the curation is not the host. Putting their name on a
     * card would be wrong AND a small privacy leak — the one place a founder's
     * real name would appear on an attendee-facing surface.
     */
    const host = eventHost({
      curated_at: new Date(),
      organizer_org: null,
      organizer: { name: "Sagar" },
    })
    expect(host.name).toBe(PLATFORM_HOST)
    expect(host.isPlatform).toBe(true)
  })

  it("shows the creating user for an event that predates organisations", () => {
    expect(eventHost({
      curated_at: null, organizer_org: null, organizer: { name: "Priya" },
    })).toEqual({ name: "Priya", isPlatform: false })
  })

  it("tells the client when it is the platform standing in", () => {
    // A curated listing should say where it came from and offer the claim; an
    // organiser's event should not.
    expect(eventHost({ curated_at: new Date(), organizer_org: null, organizer: null }).isPlatform)
      .toBe(true)
  })
})
