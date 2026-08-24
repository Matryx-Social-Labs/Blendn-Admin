import { readFileSync } from "fs"
import { join } from "path"
import {
  curationState,
  claimRefusal,
  curatedDescription,
  curatedFence,
  CURATED_RADIUS_METRES,
  CURATED_BUFFER_METRES,
} from "@/lib/curation"
import { GEOFENCE_LIMITS, validateGeofence } from "@/lib/geofence"
import { canPublish } from "@/lib/geofence-input"
import { isAggregatorSource, sourceDomain } from "@/lib/curation-sources"

/**
 * Curated events: the platform puts something in an empty city, and the real
 * organiser claims it. The claim is the acquisition.
 */

const HOUR = 60 * 60 * 1000
const NOW = new Date("2026-09-10T20:00:00Z")
const ev = (o: Partial<Parameters<typeof claimRefusal>[0]> = {}) => ({
  curated_at: new Date("2026-09-01T00:00:00Z"),
  claimed_at: null,
  organizer_org_id: null,
  start_time: new Date("2026-09-12T19:00:00Z"),
  end_time: new Date("2026-09-12T23:00:00Z"),
  ...o,
})

describe("which events are the platform's", () => {
  it("does not mistake a legacy row for a curated one", () => {
    /*
     * The whole reason `curated_at` is a column.
     *
     * `organizer_org_id IS NULL` is true of legacy rows, of everything created
     * before anything wrote that column, AND of a curated event awaiting a
     * claim. Measured against production on 2026-08-24: 18 of 28 events had a
     * null org and not one was curated. Reusing it would have offered a
     * stranger the chance to claim a real organiser's event.
     */
    expect(curationState({ curated_at: null, claimed_at: null, organizer_org_id: null }))
      .toBe("legacy")
    expect(curationState({ curated_at: new Date(), claimed_at: null, organizer_org_id: null }))
      .toBe("curated_open")
  })

  it("separates an organiser's own event from both", () => {
    expect(curationState({ curated_at: null, claimed_at: null, organizer_org_id: "org-1" }))
      .toBe("organiser")
  })

  it("keeps `claimed` distinct from `has an owner now`", () => {
    /*
     * Ownership answers *who*; `claimed_at` answers *what happened*. Keeping
     * them apart means a later transfer between organisations does not make a
     * curated event look uncurated.
     */
    expect(curationState({
      curated_at: new Date(), claimed_at: new Date(), organizer_org_id: "org-2",
    })).toBe("curated_claimed")
  })
})

describe("who may claim, and when", () => {
  it("refuses a claim on an organiser's own event", () => {
    expect(claimRefusal(ev({ curated_at: null }), NOW)).toBe("not_curated")
  })

  it("refuses a second claim once one is approved", () => {
    expect(claimRefusal(ev({ claimed_at: new Date() }), NOW)).toBe("already_claimed")
  })

  it("allows a claim before doors", () => {
    // `isClaimable` was a one-line wrapper over this and had no caller -- every
    // read path used `claimRefusal` directly for the reason, not just the yes/no.
    expect(claimRefusal(ev(), NOW)).toBeNull()
  })

  it("REFUSES a claim while the room is live", () => {
    /*
     * Delay costs a real organiser a few hours. Approving hands a stranger the
     * attendee list for people physically in a building right now, and there is
     * no undo -- `unclaimEvent` can return the column and cannot un-see a
     * roster.
     *
     * The venue queue's "does not have to be bulletproof, because auto-link is
     * reversible" argument is exactly what does not transfer here.
     */
    const duringDoors = new Date("2026-09-12T20:00:00Z")
    expect(claimRefusal(ev(), duringDoors)).toBe("room_open")
  })

  it("keeps refusing until the room closes, not until the event ends", () => {
    /*
     * An approval an hour after the last song still hands over a live
     * conversation. The bound is the chat window, not `end_time`.
     */
    const justAfterEnd = new Date("2026-09-12T23:30:00Z")
    expect(claimRefusal(ev(), justAfterEnd)).toBe("room_open")
  })

  it("allows a claim once the room has closed", () => {
    const wellAfter = new Date(new Date("2026-09-12T23:00:00Z").getTime() + 72 * HOUR)
    expect(claimRefusal(ev(), wellAfter)).toBeNull()
  })
})

describe("the aggregator flag", () => {
  it("catches the case that would let one address claim everything", () => {
    /*
     * A domain match is good evidence when the source is the organiser's own
     * site and CATASTROPHIC when it is a ticketing aggregator: one address at a
     * large platform would match the source of every event curated from it.
     */
    expect(isAggregatorSource("https://in.bookmyshow.com/events/xyz")).toBe(true)
    expect(isAggregatorSource("https://www.eventbrite.co.uk/e/123")).toBe(true)
  })

  it("matches parent domains, so subdomains do not need listing", () => {
    expect(isAggregatorSource("https://events.eventbrite.com/x")).toBe(true)
  })

  it("does not flag an organiser's own site", () => {
    expect(isAggregatorSource("https://thehummingtree.com/gigs/friday")).toBe(false)
  })

  it("does not substring-match", () => {
    /*
     * The same trap `FREE_PROVIDERS` documents: a substring rule would class
     * `not-eventbrite.com` as an aggregator and flag an honest claimant.
     */
    expect(isAggregatorSource("https://not-eventbrite.com/e/1")).toBe(false)
    expect(isAggregatorSource("https://bookmyshow.com.evil.example/x")).toBe(false)
  })

  it("treats a non-URL as no signal rather than as a flag", () => {
    expect(sourceDomain("not a url")).toBeNull()
    expect(isAggregatorSource("not a url")).toBe(false)
    expect(isAggregatorSource(null)).toBe(false)
  })
})

describe("what a curated event says about itself", () => {
  it("describes it from facts, never from the listing's prose", () => {
    /*
     * Decision 2 forbids reproducing a listing's words or images. The reason is
     * not only legal: a description lifted from elsewhere reads as somebody
     * else's, and "we found this, go and check the source" is the line that
     * keeps the platform trustworthy when a detail turns out to be wrong.
     */
    const d = curatedDescription({
      title: "Friday Sessions", venueName: "The Humming Tree", city: "Bengaluru",
    })
    expect(d).toContain("Friday Sessions at The Humming Tree, Bengaluru")
    expect(d).toContain("Listed by Blendn from a public listing")
  })

  it("reads properly when the venue or city is missing", () => {
    expect(curatedDescription({ title: "A night out", venueName: null, city: null }))
      .toBe("A night out. Listed by Blendn from a public listing — see the source for details and tickets.")
  })
})

describe("the source URL is not editable by a claimant", () => {
  it("is absent from the event write schema", () => {
    /*
     * The whole reason `source_url` is a separate column from `external_link`.
     * An owner may edit the link they show attendees; nobody may edit the URL
     * their own claim is verified against. A claimant who could repoint this at
     * their own domain would be verifying themselves.
     */
    const schema = readFileSync(join(__dirname, "..", "lib/validations/event.ts"), "utf8")
    expect(schema).not.toMatch(/source_url/)
  })
})

describe("the curated fence errs loose, deliberately", () => {
  it("is looser than an organiser's own", () => {
    /*
     * A curated pin is an estimate made by somebody who has never stood there —
     * geocoded from a listing, confirmed on a map by an admin who is also
     * guessing. An organiser drawing their own fence knows where the door is.
     *
     * The two ways to be wrong are not symmetric. Too tight turns somebody
     * standing inside away at the door — the product failing at the one moment
     * it has to work, and they will not try twice. Too loose costs an inflated
     * headcount. Too tight is the more expensive error.
     */
    const fence = curatedFence(12.97, 77.59)
    expect(fence.type).toBe("circle")
    expect(fence.radius).toBe(CURATED_RADIUS_METRES)
    expect(fence.buffer).toBe(CURATED_BUFFER_METRES)
    expect(CURATED_BUFFER_METRES).toBeGreaterThan(0)
  })

  it("stays inside the limits the geofence module enforces", () => {
    // A fence the validator would reject is a fence that publishes nothing.
    expect(CURATED_RADIUS_METRES).toBeLessThanOrEqual(GEOFENCE_LIMITS.MAX_RADIUS)
    expect(CURATED_BUFFER_METRES).toBeLessThanOrEqual(GEOFENCE_LIMITS.MAX_BUFFER)
    expect(validateGeofence(curatedFence(12.97, 77.59)).ok).toBe(true)
  })

  it("passes the publish gate that had no caller until #268", () => {
    /*
     * A curated pin is the most likely of all pins to be missing, because
     * nobody stood there — which is exactly the case `canPublish` was written
     * for and never called on.
     */
    expect(canPublish({
      latitude: 12.97, longitude: 77.59, geofence: curatedFence(12.97, 77.59),
    }).ok).toBe(true)
  })
})

describe("the curation write path", () => {
  const src = readFileSync(join(__dirname, "..", "app/dashboard/events/curate/actions.ts"), "utf8")
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

  it("copies neither the image nor the prose", () => {
    /*
     * Decision 2. Not only legal: a description lifted from elsewhere reads as
     * somebody else's, and "we found this, go and check the source" is the line
     * that keeps the platform trustworthy when a detail turns out to be wrong.
     */
    expect(code).not.toMatch(/cover_image_url/)
    expect(code).not.toMatch(/full_description/)
    expect(code).toMatch(/description: curatedDescription\(/)
  })

  it("is app_admin only, not any dashboard role", () => {
    /*
     * An organiser adding events "on behalf of" somebody else is the confusion
     * the claim funnel exists to resolve — and it would let them mint an event
     * another organiser could then be offered.
     */
    expect(code).toMatch(/role !== "app_admin"/)
    expect(code).not.toMatch(/canAccessDashboard/)
  })

  it("marks it curated and records where it came from", () => {
    expect(code).toMatch(/curated_at: new Date\(\)/)
    expect(code).toMatch(/source_url: v\.source_url/)
  })

  it("leaves ownership null so a claim is one write", () => {
    // eventPermissions short-circuits app_admin, so the platform can operate it
    // meanwhile without a placeholder organisation to special-case.
    expect(code).toMatch(/organizer_org_id: null/)
  })

  it("gates on canPublish before it writes", () => {
    const gateAt = code.indexOf("canPublish(")
    const writeAt = code.indexOf("db.events.create")
    expect(gateAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(gateAt)
  })

  it("audits the source domain, not the whole URL", () => {
    // Enough to answer "where are we curating from" without putting a query
    // string in the audit trail.
    expect(code).toMatch(/source: sourceDomain\(v\.source_url\)/)
  })
})
