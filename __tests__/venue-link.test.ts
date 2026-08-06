const mockDb = { venues: { findUnique: jest.fn() } }
jest.mock("@/lib/db", () => ({ db: mockDb }))

import { resolveVenueLink, NO_VENUE_LINK } from "@/lib/venue-link"

const VENUE = "venue_1"

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.venues.findUnique.mockResolvedValue({ id: VENUE })
})

/**
 * Linking an event to a listed venue.
 *
 * The link is what makes venue inheritance real, and it is also what gives a
 * venue owner the chatroom and attendee count for an event that is not theirs.
 * So the status is derived here rather than accepted from the request.
 */

describe("venue_link_status is never taken from the client", () => {
  it("always starts at auto_linked, whatever the caller intended", async () => {
    // A client that could send `confirmed` would link its event to someone
    // else's venue and mark it settled in one call, skipping the dispute path.
    expect(await resolveVenueLink(VENUE)).toEqual({
      venue_id: VENUE,
      venue_link_status: "auto_linked",
    })
  })

  it("preserves a status a venue owner already set", async () => {
    // Re-saving the event to fix a typo must not reset a dispute.
    expect(
      await resolveVenueLink(VENUE, { venue_id: VENUE, venue_link_status: "disputed" })
    ).toEqual({ venue_id: VENUE, venue_link_status: "disputed" })

    expect(
      await resolveVenueLink(VENUE, { venue_id: VENUE, venue_link_status: "confirmed" })
    ).toEqual({ venue_id: VENUE, venue_link_status: "confirmed" })
  })

  it("does not carry a status across a change of venue", async () => {
    // A confirmation applies to the venue it was made about, not to the next
    // one the organiser picks.
    expect(
      await resolveVenueLink(VENUE, { venue_id: "venue_other", venue_link_status: "confirmed" })
    ).toEqual({ venue_id: VENUE, venue_link_status: "auto_linked" })
  })
})

describe("what counts as no link", () => {
  it.each([[null], [undefined], [""], ["   "], [123], [{}], [["a"]]])(
    "treats %p as unlinked without touching the database",
    async (input) => {
      expect(await resolveVenueLink(input)).toEqual(NO_VENUE_LINK)
      expect(mockDb.venues.findUnique).not.toHaveBeenCalled()
    }
  )

  it("drops an id that matches no venue rather than failing the save", async () => {
    // Failing the whole event update over a stale link would lose the
    // organiser's work for something they cannot see or fix. The venue *name*
    // still saves.
    mockDb.venues.findUnique.mockResolvedValue(null)
    expect(await resolveVenueLink("venue_gone")).toEqual(NO_VENUE_LINK)
  })

  it("will not link to a soft-deleted venue", async () => {
    await resolveVenueLink(VENUE)
    expect(mockDb.venues.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VENUE, deleted_at: null } })
    )
  })
})
