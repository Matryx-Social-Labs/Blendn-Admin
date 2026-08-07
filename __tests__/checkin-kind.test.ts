import { checkInKindFor } from "@/lib/checkin-kind"

/**
 * Working, or attending?
 *
 * Organisers and venue staff check in through the same button as everyone else
 * and the client app has no notion of roles. The server decides from
 * organisation membership, and every number downstream depends on it being
 * right: occupancy counts both, attendance and turn-up count guests only.
 */

const MY_ORG = "org_mine"
const THEIR_ORG = "org_theirs"
const VENUE_ORG = "org_venue"

const actor = (...orgIds: string[]) => ({ orgIds })

describe("checkInKindFor", () => {
  it("marks the organising org's people as staff", () => {
    expect(
      checkInKindFor(actor(MY_ORG), { organizer_org_id: MY_ORG, venue: null })
    ).toBe("staff")
  })

  it("marks the venue-owning org's people as staff", () => {
    // A venue's own staff are working even though someone else runs the night.
    expect(
      checkInKindFor(actor(VENUE_ORG), {
        organizer_org_id: THEIR_ORG,
        venue: { owner_org_id: VENUE_ORG },
      })
    ).toBe("staff")
  })

  it("marks an ordinary guest as an attendee", () => {
    expect(
      checkInKindFor(actor(), { organizer_org_id: MY_ORG, venue: { owner_org_id: VENUE_ORG } })
    ).toBe("attendee")
  })

  it("marks an organiser at SOMEONE ELSE'S event as a guest", () => {
    // The case a role check gets wrong. They are an organiser by role and a
    // punter by circumstance, and tonight they are a punter.
    expect(
      checkInKindFor(actor(MY_ORG), {
        organizer_org_id: THEIR_ORG,
        venue: { owner_org_id: VENUE_ORG },
      })
    ).toBe("attendee")
  })

  it("counts an app_admin as a guest, because they have no org", () => {
    // `actorFor` returns orgIds: [] for app_admin. A support visit therefore
    // inflates guest attendance by one, which is a far smaller distortion than
    // silently removing them from a number the organiser is reading.
    expect(
      checkInKindFor(actor(), { organizer_org_id: MY_ORG, venue: null })
    ).toBe("attendee")
  })

  it("does not match a null organiser org against a null-ish membership", () => {
    // An event with no organising org must not make everyone staff.
    expect(
      checkInKindFor(actor(MY_ORG), { organizer_org_id: null, venue: null })
    ).toBe("attendee")
  })

  it("does not match a null venue owner", () => {
    // An unclaimed venue has owner_org_id null; that is not membership.
    expect(
      checkInKindFor(actor(MY_ORG), {
        organizer_org_id: THEIR_ORG,
        venue: { owner_org_id: null },
      })
    ).toBe("attendee")
  })

  it("survives an event with no venue at all", () => {
    // Most events are at free-text venues with no linked record.
    expect(
      checkInKindFor(actor(MY_ORG), { organizer_org_id: MY_ORG })
    ).toBe("staff")
  })

  it("is staff when the person belongs to both orgs", () => {
    expect(
      checkInKindFor(actor(MY_ORG, VENUE_ORG), {
        organizer_org_id: MY_ORG,
        venue: { owner_org_id: VENUE_ORG },
      })
    ).toBe("staff")
  })
})
