const mockDb = {
  venues: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  organisation_members: { findFirst: jest.fn() },
  events: { count: jest.fn() },
}

const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import {
  venuesNear,
  createVenue,
  assignVenueOwner,
  retireVenue,
  restoreVenue,
  updateVenue,
} from "@/lib/venue-actions"

const MY_ORG = "org_mine"
/** Toit, Indiranagar — a real pin, so the distances below are real distances. */
const LAT = 12.9784
const LNG = 77.6408

function signIn(role: string) {
  mockAuth.mockResolvedValue({ user: { id: "user_1", role } })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.organisation_members.findFirst.mockResolvedValue({ org_id: MY_ORG })
  mockDb.venues.create.mockResolvedValue({ id: "venue_new" })
  mockDb.venues.findMany.mockResolvedValue([])
  mockDb.venues.findUnique.mockResolvedValue({
    id: "venue_1",
    name: "Toit",
    owner_org_id: MY_ORG,
  })
  mockDb.venues.updateMany.mockResolvedValue({ count: 1 })
  mockDb.events.count.mockResolvedValue(0)
})

/**
 * The first write path this table has ever had.
 *
 * Two records for one building is how "The Loft" and "the loft" both come to
 * exist, and once they do nothing reconciles them — so the dedup gate is the
 * part worth testing, along with who is allowed through it.
 */

describe("venuesNear — the duplicate check", () => {
  beforeEach(() => signIn("venue_owner"))

  it("keeps venues inside 100 m and drops the ones beyond", async () => {
    mockDb.venues.findMany.mockResolvedValue([
      { id: "a", name: "Close", address: null, city: null, latitude: LAT, longitude: LNG, owner_org_id: null, owner_org: null },
      // ~0.005° of latitude is roughly 550 m — comfortably outside.
      { id: "b", name: "Far", address: null, city: null, latitude: LAT + 0.005, longitude: LNG, owner_org_id: null, owner_org: null },
    ])
    const hits = await venuesNear(LAT, LNG)
    expect(hits.map((h) => h.id)).toEqual(["a"])
  })

  it("skips rows with no coordinates instead of treating them as at 0,0", async () => {
    mockDb.venues.findMany.mockResolvedValue([
      { id: "a", name: "No pin", address: null, city: null, latitude: null, longitude: null, owner_org_id: null, owner_org: null },
    ])
    expect(await venuesNear(LAT, LNG)).toEqual([])
  })

  it("hides the owning organisation from non-admins", async () => {
    // A host learning which company owns which venue is a customer list.
    mockDb.venues.findMany.mockResolvedValue([
      { id: "a", name: "Owned", address: null, city: null, latitude: LAT, longitude: LNG, owner_org_id: "org_x", owner_org: { display_name: "Secret Ltd" } },
    ])
    const [hit] = await venuesNear(LAT, LNG)
    expect(hit.claimed).toBe(true)
    expect(hit.ownerName).toBeNull()
  })

  it("shows it to an admin, who needs it to resolve disputes", async () => {
    signIn("app_admin")
    mockDb.venues.findMany.mockResolvedValue([
      { id: "a", name: "Owned", address: null, city: null, latitude: LAT, longitude: LNG, owner_org_id: "org_x", owner_org: { display_name: "Secret Ltd" } },
    ])
    const [hit] = await venuesNear(LAT, LNG)
    expect(hit.ownerName).toBe("Secret Ltd")
  })

  it("sorts nearest first", async () => {
    mockDb.venues.findMany.mockResolvedValue([
      { id: "far", name: "Far", address: null, city: null, latitude: LAT + 0.0006, longitude: LNG, owner_org_id: null, owner_org: null },
      { id: "near", name: "Near", address: null, city: null, latitude: LAT, longitude: LNG, owner_org_id: null, owner_org: null },
    ])
    expect((await venuesNear(LAT, LNG)).map((h) => h.id)).toEqual(["near", "far"])
  })
})

describe("createVenue", () => {
  it("refuses an organiser — a venue grants control over other people's events", async () => {
    signIn("organizer")
    await expect(
      createVenue({ name: "Toit", venueType: "brewery", lat: LAT, lng: LNG })
    ).rejects.toThrow(/forbidden/i)
    expect(mockDb.venues.create).not.toHaveBeenCalled()
  })

  it("blocks a duplicate the caller has not acknowledged, and names the neighbour", async () => {
    signIn("venue_owner")
    mockDb.venues.findMany.mockResolvedValue([
      { id: "a", name: "Toit", address: null, city: null, latitude: LAT, longitude: LNG, owner_org_id: null, owner_org: null },
    ])
    await expect(
      createVenue({ name: "Toit Brewpub", venueType: "brewery", lat: LAT, lng: LNG })
    ).rejects.toThrow(/Toit is already listed/)
  })

  it("lets it through once acknowledged — same address, different hall is real", async () => {
    signIn("venue_owner")
    mockDb.venues.findMany.mockResolvedValue([
      { id: "a", name: "Toit", address: null, city: null, latitude: LAT, longitude: LNG, owner_org_id: null, owner_org: null },
    ])
    await expect(
      createVenue({
        name: "Toit Rooftop",
        venueType: "lounge_rooftop",
        lat: LAT,
        lng: LNG,
        acknowledgedDuplicates: true,
      })
    ).resolves.toEqual({ id: "venue_new" })
  })

  it("seeds a circle sized for the venue type when none is drawn", async () => {
    // One default for a café and a stadium alike is how a football match ended
    // up with a 100 km radius.
    signIn("venue_owner")
    await createVenue({ name: "Chinnaswamy", venueType: "stadium", lat: LAT, lng: LNG })
    const cafe = mockDb.venues.create.mock.calls[0][0].data.geofence
    expect(cafe.type).toBe("circle")

    mockDb.venues.create.mockClear()
    await createVenue({ name: "Third Wave", venueType: "cafe", lat: LAT, lng: LNG })
    expect(mockDb.venues.create.mock.calls[0][0].data.geofence.radius).toBeLessThan(cafe.radius)
  })

  it("rejects a geofence that fails validation rather than storing it", async () => {
    signIn("venue_owner")
    await expect(
      createVenue({
        name: "Toit",
        venueType: "brewery",
        lat: LAT,
        lng: LNG,
        // Above the 2000 m server cap.
        geofence: { type: "circle", lat: LAT, lng: LNG, radius: 100000, buffer: 20 },
      })
    ).rejects.toThrow(/not valid/i)
    expect(mockDb.venues.create).not.toHaveBeenCalled()
  })

  it("owns the venue from creation for a venue owner, and leaves it unclaimed for an admin", async () => {
    // A venue owner describing their own place should not have to create it
    // then claim it — that is ceremony with no safety value.
    signIn("venue_owner")
    await createVenue({ name: "Toit", venueType: "brewery", lat: LAT, lng: LNG })
    expect(mockDb.venues.create.mock.calls[0][0].data.owner_org_id).toBe(MY_ORG)

    mockDb.venues.create.mockClear()
    signIn("app_admin")
    await createVenue({ name: "Toit", venueType: "brewery", lat: LAT, lng: LNG })
    const data = mockDb.venues.create.mock.calls[0][0].data
    expect(data.owner_org_id).toBeNull()
    expect(data.claimed_at).toBeNull()
  })

  it("requires a name and a pin", async () => {
    signIn("venue_owner")
    await expect(
      createVenue({ name: "T", venueType: "brewery", lat: LAT, lng: LNG })
    ).rejects.toThrow(/name/i)
    await expect(
      createVenue({ name: "Toit", venueType: "brewery", lat: NaN, lng: LNG })
    ).rejects.toThrow(/map/i)
  })
})

describe("assignVenueOwner", () => {
  beforeEach(() => signIn("app_admin"))

  it("refuses to reassign an owned venue — that is a dispute", async () => {
    mockDb.venues.findUnique.mockResolvedValue({ name: "Toit", owner_org_id: "org_other" })
    await expect(assignVenueOwner("venue_1", MY_ORG)).rejects.toThrow(/already has an owner/i)
    expect(mockDb.venues.update).not.toHaveBeenCalled()
  })

  it("is idempotent when the same org is assigned again", async () => {
    mockDb.venues.findUnique.mockResolvedValue({ name: "Toit", owner_org_id: MY_ORG })
    await expect(assignVenueOwner("venue_1", MY_ORG)).resolves.toBeUndefined()
  })

  it("refuses a non-admin", async () => {
    signIn("venue_owner")
    await expect(assignVenueOwner("venue_1", MY_ORG)).rejects.toThrow(/forbidden/i)
  })
})

describe("retiring a venue", () => {
  /*
   * `venues.status` and `venues.deleted_at` had no writer at all. A venue, once
   * created, was permanent — the inverse of what a place is supposed to be.
   */
  it("refuses while an event is still booked there", async () => {
    /*
     * The refusal that matters. Retiring a venue with a future event booked
     * leaves that event pointing at a place no screen will show, and the
     * organiser finds out at the door. Moving the event is a decision with a
     * person in it, so it cannot be done implicitly here.
     */
    signIn("app_admin")
    mockDb.events.count.mockResolvedValue(2)

    await expect(retireVenue("venue_1")).rejects.toThrow(/still booked/)
    expect(mockDb.venues.updateMany).not.toHaveBeenCalled()
  })

  it("counts only events that have not finished", async () => {
    // Past events at a retired venue are its history, not a reason to refuse.
    signIn("app_admin")
    await retireVenue("venue_1")

    const where = mockDb.events.count.mock.calls[0][0].where
    expect(where.end_time).toEqual({ gte: expect.any(Date) })
    expect(where.deleted_at).toBeNull()
  })

  it("writes both columns, because one without the other is a contradiction", async () => {
    signIn("app_admin")
    await retireVenue("venue_1")

    const call = mockDb.venues.updateMany.mock.calls[0][0]
    expect(call.data.status).toBe("archived")
    expect(call.data.deleted_at).toBeInstanceOf(Date)
    // Guarded on still being live, so a double submit does not rewrite when.
    expect(call.where.deleted_at).toBeNull()
  })

  it("tells the second click the truth rather than rewriting the first", async () => {
    signIn("app_admin")
    mockDb.venues.updateMany.mockResolvedValue({ count: 0 })
    await expect(retireVenue("venue_1")).rejects.toThrow(/already retired/)
  })

  it("lets an owner retire their own", async () => {
    signIn("venue_owner")
    await expect(retireVenue("venue_1")).resolves.toBeUndefined()
  })

  it("refuses a stranger", async () => {
    signIn("venue_owner")
    mockDb.organisation_members.findFirst.mockResolvedValue(null)
    await expect(retireVenue("venue_1")).rejects.toThrow(/Forbidden/)
  })
})

describe("restoring a venue", () => {
  it("is admin only, because it is a statement about the catalogue", async () => {
    /*
     * Asymmetric on purpose: an owner may retire their own venue, and only an
     * admin may bring one back. "This place is open again" is a claim about
     * what the product offers, not about one organisation.
     */
    signIn("venue_owner")
    await expect(restoreVenue("venue_1")).rejects.toThrow(/Forbidden/)

    signIn("app_admin")
    await expect(restoreVenue("venue_1")).resolves.toBeUndefined()
    expect(mockDb.venues.updateMany.mock.calls[0][0].where.deleted_at).toEqual({ not: null })
  })
})

describe("correcting the pin", () => {
  it("refuses half a coordinate pair", async () => {
    /*
     * Half a pair would move the venue to the equator or the prime meridian
     * rather than failing — a wrong answer that looks like a working save.
     */
    signIn("app_admin")
    await expect(updateVenue("venue_1", { lat: 12.97 })).rejects.toThrow(/both/)
    await expect(updateVenue("venue_1", { lng: 77.59 })).rejects.toThrow(/both/)
    expect(mockDb.venues.update).not.toHaveBeenCalled()
  })

  it("refuses coordinates off the globe", async () => {
    signIn("app_admin")
    await expect(updateVenue("venue_1", { lat: 91, lng: 0 })).rejects.toThrow(/Latitude/)
    await expect(updateVenue("venue_1", { lat: 0, lng: 181 })).rejects.toThrow(/Longitude/)
  })

  it("writes both when both are given", async () => {
    signIn("app_admin")
    await updateVenue("venue_1", { lat: 19.076, lng: 72.877 })

    const data = mockDb.venues.update.mock.calls[0][0].data
    expect(data.latitude).toBe(19.076)
    expect(data.longitude).toBe(72.877)
  })

  it("leaves the pin alone when neither is given", async () => {
    signIn("app_admin")
    await updateVenue("venue_1", { name: "New name" })

    const data = mockDb.venues.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty("latitude")
    expect(data).not.toHaveProperty("longitude")
  })
})
