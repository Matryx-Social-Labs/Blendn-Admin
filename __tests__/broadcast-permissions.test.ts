import {
  broadcastMayCarryMedia,
  canBroadcast,
  type BroadcastKind,
  type PermissionActor,
  type PermissionEvent,
} from "@/lib/rbac"

/**
 * Who may put a non-user message into an event's room.
 *
 * This suite exists because the route it guards had the bug for months: it
 * compared `event.organizer_id` to the caller's id and never touched the
 * resolver, which refused an app_admin, refused the venue owner whose building
 * the event was in, and refused a colleague at the organising org — all while
 * looking like a permission check.
 */

const ORG = "org-host"
const VENUE_ORG = "org-venue"

const admin: PermissionActor = { id: "u-admin", role: "app_admin", orgIds: [] }
const host: PermissionActor = { id: "u-host", role: "organizer", orgIds: [ORG] }
const venueOwner: PermissionActor = {
  id: "u-venue",
  role: "venue_owner",
  orgIds: [VENUE_ORG],
}
const stranger: PermissionActor = { id: "u-x", role: "organizer", orgIds: ["org-other"] }
const attendee: PermissionActor = { id: "u-a", role: "attendee", orgIds: [] }

const event: PermissionEvent = {
  organizer_org_id: ORG,
  venue: { owner_org_id: VENUE_ORG },
}

describe("announcement — anyone who operates the event", () => {
  it("lets the organising org broadcast", () => {
    expect(canBroadcast(host, event, "announcement")).toBe(true)
  })

  it("lets the venue owner broadcast for an event in their building", () => {
    /*
     * The row the old owner check got wrong and could never have got right:
     * `canOperate` is true for a venue owner while `canEdit` is false. What
     * happens in your building is yours to speak to, even though the event is
     * not yours to change.
     */
    expect(canBroadcast(venueOwner, event, "announcement")).toBe(true)
  })

  it("lets an app_admin broadcast anywhere", () => {
    // Also previously refused, since an admin is not the event's organizer_id.
    expect(canBroadcast(admin, event, "announcement")).toBe(true)
  })

  it("refuses an organiser from an unrelated org", () => {
    expect(canBroadcast(stranger, event, "announcement")).toBe(false)
  })

  it("refuses an attendee", () => {
    expect(canBroadcast(attendee, event, "announcement")).toBe(false)
  })

  it("refuses an actor with no organisation at all", () => {
    // The `orgIds: []` hole, in its broadcast form.
    expect(canBroadcast({ ...host, orgIds: [] }, event, "announcement")).toBe(false)
  })
})

describe("sponsored — operating is necessary and not sufficient", () => {
  it("refuses an operator whose org may not sell placement", () => {
    /*
     * The whole point of the separate flag. If everyone who can announce can
     * also mark a message sponsored, the label stops meaning "somebody paid"
     * and becomes a styling choice — and a reader has no way to tell an
     * advertisement from an announcement.
     */
    expect(canBroadcast(host, event, "sponsored", false)).toBe(false)
  })

  it("allows it once the organisation is approved", () => {
    expect(canBroadcast(host, event, "sponsored", true)).toBe(true)
  })

  it("still requires operating the event, flag or not", () => {
    // An approved org cannot advertise in somebody else's room.
    expect(canBroadcast(stranger, event, "sponsored", true)).toBe(false)
  })

  it("lets an app_admin place one without the flag", () => {
    /*
     * Not an oversight. `may_sponsor` is a delegation of the platform's own
     * ability to sell placement, so the platform holding it unconditionally is
     * the thing being delegated.
     */
    expect(canBroadcast(admin, event, "sponsored", false)).toBe(true)
  })

  it("lets the venue owner place one when their org is approved", () => {
    expect(canBroadcast(venueOwner, event, "sponsored", true)).toBe(true)
  })
})

describe("system — the platform's own voice", () => {
  it("is app_admin only", () => {
    expect(canBroadcast(admin, event, "system")).toBe(true)
  })

  it("is refused to the organising org, however senior", () => {
    /*
     * It renders as Blend'n. An organiser who could send one could issue a
     * safety notice, or a "verified by Blend'n" claim, in the platform's voice.
     */
    expect(canBroadcast(host, event, "system")).toBe(false)
    expect(canBroadcast(venueOwner, event, "system")).toBe(false)
  })

  it("is refused even to an org allowed to sponsor", () => {
    // The two capabilities are unrelated; buying placement is not speaking as
    // the platform.
    expect(canBroadcast(host, event, "system", true)).toBe(false)
  })
})

describe("media rides on sponsored alone", () => {
  it("allows it for sponsored", () => {
    expect(broadcastMayCarryMedia("sponsored")).toBe(true)
  })

  it("refuses it for announcements and system messages", () => {
    /*
     * The event room is pseudonymous and a photograph is an identity — of
     * whoever is in it, who is not always the person posting. Attendee media is
     * not built at all, and an announcement is a host addressing that same
     * room, so it inherits the rule. Sponsored artwork depicts nobody in the
     * room, which is what makes it the exception.
     */
    expect(broadcastMayCarryMedia("announcement")).toBe(false)
    expect(broadcastMayCarryMedia("system")).toBe(false)
  })
})

describe("an event with no venue", () => {
  const noVenue: PermissionEvent = { organizer_org_id: ORG, venue: null }

  it("still lets the organising org broadcast", () => {
    expect(canBroadcast(host, noVenue, "announcement")).toBe(true)
  })

  it("gives a venue owner nothing to own", () => {
    // Most events are at places not on the platform, so this is the common
    // shape rather than an edge case.
    expect(canBroadcast(venueOwner, noVenue, "announcement")).toBe(false)
  })
})

describe("fails closed", () => {
  it("refuses a half-built actor", () => {
    const broken = { id: "", role: "organizer", orgIds: [ORG] } as PermissionActor
    for (const kind of ["announcement", "sponsored", "system"] as BroadcastKind[]) {
      expect(canBroadcast(broken, event, kind, true)).toBe(false)
    }
  })

  it("defaults maySponsor to false rather than true", () => {
    // A caller who forgets the argument must be refused, not granted. The
    // default is the whole difference between a scarce label and a free one.
    expect(canBroadcast(host, event, "sponsored")).toBe(false)
  })
})
