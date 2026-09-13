/*
 * The amenity vocabulary gets a writer, and retiring is not deleting.
 *
 * Fourteen rows were seeded inside a migration and nothing wrote the table
 * again. `is_active` is a fully designed retirement mechanism — a `Restrict`
 * foreign key so a used amenity cannot vanish, a tick-through on the event
 * form, an index on `(is_active, sort_order)` — and it was unreachable without
 * a manual `UPDATE` against production.
 *
 * Two decisions here could regress quietly, so both are pinned:
 *
 *   - **Retire, never delete.** `event_amenities` is `onDelete: Restrict`, and
 *     that is right: deleting an amenity rewrites what past events said they
 *     offered. A `delete` here would either throw on every used amenity or, if
 *     somebody "fixed" the constraint, silently edit history.
 *   - **The slug survives a rename.** It is the identifier the client maps to a
 *     glyph, not a label. Recomputing it on rename would drop the icon on every
 *     event already offering the amenity — a cosmetic edit with a consequence
 *     nobody would connect back to it.
 */

const mockDb = {
  amenities: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    aggregate: jest.fn(),
  },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))

import { setAmenityActive, updateAmenity, createAmenity } from "@/lib/amenity-actions"

const ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "app_admin" } })
  mockDb.amenities.findMany.mockResolvedValue([])
  mockDb.amenities.aggregate.mockResolvedValue({ _max: { sort_order: 30 } })
})

describe("retiring an amenity", () => {
  it("flips is_active and never deletes", async () => {
    mockDb.amenities.findUnique.mockResolvedValue({ id: ID, name: "Open Bar", is_active: true })

    await setAmenityActive(ID, false)

    expect(mockDb.amenities.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID }, data: expect.objectContaining({ is_active: false }) })
    )
    expect(mockDb.amenities.delete).not.toHaveBeenCalled()
    expect(mockDb.amenities.deleteMany).not.toHaveBeenCalled()
  })

  it("can bring one back", async () => {
    mockDb.amenities.findUnique.mockResolvedValue({ id: ID, name: "Open Bar", is_active: false })

    await setAmenityActive(ID, true)

    expect(mockDb.amenities.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ is_active: true }) })
    )
  })

  it("does nothing when it is already in that state", async () => {
    // Otherwise a double-click writes a second audit row saying it was retired
    // twice, and the log stops being a record of what happened.
    mockDb.amenities.findUnique.mockResolvedValue({ id: ID, name: "Open Bar", is_active: false })

    await setAmenityActive(ID, false)

    expect(mockDb.amenities.update).not.toHaveBeenCalled()
  })
})

describe("renaming", () => {
  it("leaves the slug alone", async () => {
    mockDb.amenities.findUnique.mockResolvedValue({ id: ID })

    await updateAmenity(ID, { name: "Free Bar" })

    const call = mockDb.amenities.update.mock.calls[0][0]
    expect(call.data.name).toBe("Free Bar")
    expect(call.data).not.toHaveProperty("slug")
  })

  it("refuses an empty name rather than writing one", async () => {
    mockDb.amenities.findUnique.mockResolvedValue({ id: ID })
    await expect(updateAmenity(ID, { name: " " })).rejects.toThrow()
    expect(mockDb.amenities.update).not.toHaveBeenCalled()
  })
})

describe("adding", () => {
  it("appends rather than landing at the top", async () => {
    /*
     * `sort_order` defaults to 0 and decides the picker's order, so a new
     * amenity would otherwise pile in with everything else that was never
     * ordered — and the explicit ordering exists because alphabetical puts
     * "Accessible Entrance" above "Open Bar" on every card in the app.
     */
    mockDb.amenities.create.mockResolvedValue({ id: ID, name: "Cloakroom" })

    await createAmenity({ name: "Cloakroom" })

    expect(mockDb.amenities.create.mock.calls[0][0].data.sort_order).toBe(40)
  })

  it("does not collide on a duplicate slug from a different name", async () => {
    // `slug` is @unique, so "Open-bar!" beside "Open Bar" would be a raw P2002
    // in an admin's face.
    mockDb.amenities.findMany.mockResolvedValue([{ slug: "open-bar" }])
    mockDb.amenities.create.mockResolvedValue({ id: ID, name: "Open-bar!" })

    await createAmenity({ name: "Open-bar!" })

    expect(mockDb.amenities.create.mock.calls[0][0].data.slug).toBe("open-bar-2")
  })

  it("refuses the same name, and says so differently when it is retired", async () => {
    // The suffix used to let a second "Cloakroom" in as `cloakroom-2`, and
    // the organiser's picker then offered Cloakroom twice.
    mockDb.amenities.findFirst.mockResolvedValueOnce({ is_active: true })
    await expect(createAmenity({ name: "cloakroom" })).rejects.toThrow("already exists")

    mockDb.amenities.findFirst.mockResolvedValueOnce({ is_active: false })
    await expect(createAmenity({ name: "Cloakroom" })).rejects.toThrow("restore it")

    expect(mockDb.amenities.create).not.toHaveBeenCalled()
  })

  it("refuses a non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "organizer" } })
    await expect(createAmenity({ name: "Cloakroom" })).rejects.toThrow("Forbidden")
    expect(mockDb.amenities.create).not.toHaveBeenCalled()
  })
})
