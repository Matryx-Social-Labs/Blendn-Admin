process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getDashboardOverview } from "@/app/dashboard/actions"
import { getBuildingOccupancy } from "@/lib/building-occupancy"
import { eventTitleFor } from "@/lib/dashboard-record-titles"
import { loadEventPage } from "@/lib/event-page"
import { updateVenue } from "@/lib/venue-actions"

import { closeDb, db, makeUser, testId } from "./helpers"
import { cleanupWorld, goLive, person, realEvent, req, venue, venueDetail, world } from "./go-live-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * The venue owner's screens (step 17, part A) against real Postgres:
 *
 *   - `venues.floors`, the 3D map's height override: written by the venue's
 *     owner or an admin, refused to the organisation that only added it,
 *     held to 1–200 by the action and by the CHECK, and carried on both mobile
 *     venue payloads;
 *   - "In the building" counts the venue's own live room, as a range for its
 *     owner and exactly for an admin;
 *   - the overview's next booking holds back another host's going count under
 *     the floor (SCRUM-501), and its heatmap reads the event's clock.
 */

const TOKEN = `zvf${Date.now().toString(36).replace(/\d/g, "")}q`

let ownerUser = ""
let ownerOrg = ""
let creatorUser = ""
let creatorOrg = ""
let admin = ""

async function org(label: string, userId: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  world.orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: userId, role: "owner" } })
  return o.id
}

const as = (id: string, role: string) => mockGetAuth.mockResolvedValue({ user: { id, role } })
const floorsOf = async (id: string) => (await db.venues.findUniqueOrThrow({ where: { id }, select: { floors: true } })).floors

beforeAll(async () => {
  ownerUser = await makeUser(testId("vo_owner"), "organizer")
  creatorUser = await makeUser(testId("vo_creator"), "organizer")
  admin = await makeUser(testId("vo_admin"), "app_admin")
  world.users.push(ownerUser, creatorUser, admin)
  await db.user.update({ where: { id: ownerUser }, data: { role: "venue_owner" } })
  ownerOrg = await org("vo-org", ownerUser)
  creatorOrg = await org("vo-creator-org", creatorUser)
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: world.users } } })
  await db.event_rsvps.deleteMany({ where: { event: { venue_id: { in: world.venues } } } })
  await cleanupWorld()
  await closeDb()
}, 120_000)

describe("venues.floors", () => {
  it("is set by the owner, read back, and recorded as a changed field", async () => {
    const id = await venue({ ownerOrg })
    as(ownerUser, "venue_owner")
    await updateVenue(id, { floors: 4 })
    expect(await floorsOf(id)).toBe(4)
    // `auditLog` writes after the action returns: polled, never a fixed sleep.
    let audit = null
    for (let i = 0; i < 50 && !audit; i++) {
      audit = await db.audit_logs.findFirst({ where: { action: "venue.updated", resource_id: id }, orderBy: { created_at: "desc" } })
      if (!audit) await new Promise((r) => setTimeout(r, 40))
    }
    expect((audit?.details as { fields: string[] } | undefined)?.fields).toEqual(["floors"])
  })

  it("is set by an admin, and cleared with null", async () => {
    const id = await venue({ ownerOrg })
    as(admin, "app_admin")
    await updateVenue(id, { floors: 12 })
    expect(await floorsOf(id)).toBe(12)
    await updateVenue(id, { floors: null })
    expect(await floorsOf(id)).toBeNull()
  })

  it("is refused to the organisation that only added an unclaimed venue, which may still correct the place", async () => {
    const id = await venue()
    await db.venues.update({ where: { id }, data: { created_by_org_id: creatorOrg } })
    as(creatorUser, "organizer")
    await expect(updateVenue(id, { floors: 3 })).rejects.toThrow("Only the venue's owner or an admin sets its floors.")
    expect(await floorsOf(id)).toBeNull()
    // The control: the same caller may still rename it, so the refusal is about floors.
    await updateVenue(id, { name: testId("Renamed") })
  })

  it.each([0, 201, 2.5, -1])("refuses %p floors and writes nothing", async (n) => {
    const id = await venue({ ownerOrg })
    as(ownerUser, "venue_owner")
    await expect(updateVenue(id, { floors: n })).rejects.toThrow("Floors is a whole number from 1 to 200")
    expect(await floorsOf(id)).toBeNull()
  })

  it("refuses an id that is not a venue's, as not found", async () => {
    as(admin, "app_admin")
    await expect(updateVenue("not-a-uuid", { floors: 3 })).rejects.toThrow("Venue not found")
  })

  it("is held to 1–200 by the database too (venues_floors_range)", async () => {
    const id = await venue({ ownerOrg })
    await expect(db.$executeRaw`UPDATE venues SET floors = 0 WHERE id = ${id}::uuid`).rejects.toThrow(/venues_floors_range/)
    await expect(db.$executeRaw`UPDATE venues SET floors = 201 WHERE id = ${id}::uuid`).rejects.toThrow(/venues_floors_range/)
    await db.$executeRaw`UPDATE venues SET floors = 200 WHERE id = ${id}::uuid`
    expect(await floorsOf(id)).toBe(200)
  })

  it("rides on GET /venues and GET /venues/:id, null when unset", async () => {
    const tall = await venue({ ownerOrg })
    const plain = await venue({ ownerOrg })
    await db.venues.update({ where: { id: tall }, data: { floors: 7, name: `${TOKEN} tall` } })
    await db.venues.update({ where: { id: plain }, data: { name: `${TOKEN} plain` } })
    const viewer = await person("vo_viewer")

    const list = await venuesRoute.GET(req(`/api/mobile/venues?search=${TOKEN}&limit=50`, viewer.token))
    expect(list.status).toBe(200)
    const rows = (await list.json()).data.venues as { id: string; floors: number | null }[]
    expect(rows.find((r) => r.id === tall)?.floors).toBe(7)
    expect(rows.find((r) => r.id === plain)).toHaveProperty("floors", null)

    const detail = await venueDetail(viewer.token, tall)
    expect(detail.status).toBe(200)
    expect(JSON.parse(detail.text).data.venue.floors).toBe(7)
  })
})

describe("In the building counts the venue's own live room", () => {
  it("as a range for the owner and exactly for an admin", async () => {
    const id = await venue({ ownerOrg })
    for (let i = 0; i < 6; i++) {
      const p = await person(`vo_live${i}`)
      expect((await goLive(p.token, id)).status).toBe(200)
    }

    const forOwner = await getBuildingOccupancy(id, { asOwner: { id: ownerUser, orgIds: [ownerOrg] } })
    expect(forOwner.rooms).toHaveLength(1)
    expect(forOwner.rooms[0]).toMatchObject({ venueDay: true, inside: "5-9", guestsInside: null, staffInside: null })

    const forAdmin = await getBuildingOccupancy(id)
    expect(forAdmin.rooms[0]).toMatchObject({ venueDay: true, inside: 6 })
    expect(forAdmin.inside).toBe(6)

    // The room's link opens the event page, which names it as the venue's
    // live room and never by its internal "Venue day ·" title (PL-I16).
    as(ownerUser, "venue_owner")
    const page = await loadEventPage(forOwner.rooms[0].eventId)
    const name = (await db.venues.findUniqueOrThrow({ where: { id }, select: { name: true } })).name
    expect(page.event.title).toBe(`Live at ${name}`)
    expect(await eventTitleFor(forOwner.rooms[0].eventId)).toBe(`Live at ${name}`)
  })
})

describe("over licence says only what the ranges prove (review M8)", () => {
  it("never flips on the exact count behind a range, whatever capacity the owner types", async () => {
    const id = await venue({ ownerOrg })
    // Another host's night with twelve inside: the owner reads "10-19".
    const night = await realEvent(id, { startsInMin: -30, link: "confirmed" })
    const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: night } })
    for (let i = 0; i < 12; i++) {
      const p = await person(`vo_lic${i}`)
      await db.presence_sessions.create({
        data: { event_id: night, occurrence_id: occ.id, user_id: p.id, arrived_at: new Date(Date.now() - 10 * 60_000) },
      })
    }
    const asOwner = { asOwner: { id: ownerUser, orgIds: [ownerOrg] } }
    const flagAt = async (capacity: number, opts = asOwner) => {
      await db.venues.update({ where: { id }, data: { capacity } })
      return (await getBuildingOccupancy(id, opts)).overCapacity
    }
    // Walking the capacity from 10 to 19 would find the 12 if the flag read it.
    const flags = []
    for (let c = 10; c <= 19; c++) flags.push(await flagAt(c))
    expect(flags.every((f) => f === false)).toBe(true)
    // Below the range's floor the range itself proves it.
    expect(await flagAt(9)).toBe(true)
    // An admin reads the exact figure, and its flag.
    expect(await flagAt(11, {} as typeof asOwner)).toBe(true)
  })
})

describe("the venue owner's overview", () => {
  it("leads with the building only while a room runs, and holds back another host's small next booking", async () => {
    // A venue of its own, so the owner's other fixtures do not crowd the read.
    const soloUser = await makeUser(testId("vo_solo"), "organizer")
    world.users.push(soloUser)
    await db.user.update({ where: { id: soloUser }, data: { role: "venue_owner" } })
    const soloOrg = await org("vo-solo-org", soloUser)
    const id = await venue({ ownerOrg: soloOrg })

    // Another host's night tomorrow with three going: under the floor for the venue.
    const theirs = await realEvent(id, { startsInMin: 24 * 60, link: "confirmed" })
    const goers = await Promise.all([0, 1, 2].map((i) => person(`vo_rsvp${i}`)))
    for (const g of goers) await db.event_rsvps.create({ data: { event_id: theirs, user_id: g.id, status: "going" } })

    as(soloUser, "venue_owner")
    const dark = await getDashboardOverview()
    if (dark.role !== "venue_owner") throw new Error("expected the venue overview")
    expect(dark.buildings).toEqual([])
    const row = dark.venues.find((v) => v.id === id)
    expect(row?.nextBooking).toMatchObject({ id: theirs, going: null })

    // The control: the same night run by the venue's own organisation shows its three.
    await db.events.update({ where: { id: theirs }, data: { organizer_org_id: soloOrg } })
    const own = await getDashboardOverview()
    if (own.role !== "venue_owner") throw new Error("expected the venue overview")
    expect(own.venues.find((v) => v.id === id)?.nextBooking).toMatchObject({ id: theirs, going: 3 })

    // Someone live at the venue: now the building leads.
    const live = await person("vo_solo_live")
    expect((await goLive(live.token, id)).status).toBe(200)
    const lit = await getDashboardOverview()
    if (lit.role !== "venue_owner") throw new Error("expected the venue overview")
    expect(lit.buildings.map((b) => b.venueId)).toEqual([id])
    expect(lit.buildings[0].occupancy.rooms[0]).toMatchObject({ venueDay: true, inside: "quiet" })
  })

  it("puts a 19:00 Bengaluru night in the evening slot, on the event's clock", async () => {
    const tzUser = await makeUser(testId("vo_tz"), "organizer")
    world.users.push(tzUser)
    await db.user.update({ where: { id: tzUser }, data: { role: "venue_owner" } })
    const tzOrg = await org("vo-tz-org", tzUser)
    const id = await venue({ ownerOrg: tzOrg })
    await db.venues.update({ where: { id }, data: { claimed_at: new Date(Date.now() - 60 * 86_400_000) } })

    // Last Wednesday, 19:00 IST = 13:30 UTC: an afternoon on a UTC server clock.
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - (((d.getUTCDay() - 3 + 7) % 7) || 7))
    d.setUTCHours(13, 30, 0, 0)
    const ev = await realEvent(id, { startsInMin: Math.round((d.getTime() - Date.now()) / 60_000), link: "confirmed" })
    await db.events.update({ where: { id: ev }, data: { timezone: "Asia/Kolkata", organizer_org_id: tzOrg } })

    as(tzUser, "venue_owner")
    const o = await getDashboardOverview()
    if (o.role !== "venue_owner") throw new Error("expected the venue overview")
    // Wednesday is index 2 (Monday-first); evening is slot 2.
    expect(o.utilisation[2][2]).toBe(1)
    expect(o.utilisation[2][1]).toBe(0)
    expect(o.peakWindow).toBe("Wed evening")

    // 01:00 IST on the Thursday after is Wednesday night's late slot (the 06:00
    // reset), not Thursday morning.
    const late = new Date(d.getTime() + 6 * 3_600_000) // Wed 13:30Z + 6h = Wed 19:30Z = Thu 01:00 IST
    const ev2 = await realEvent(id, { startsInMin: Math.round((late.getTime() - Date.now()) / 60_000), link: "confirmed" })
    await db.events.update({ where: { id: ev2 }, data: { timezone: "Asia/Kolkata", organizer_org_id: tzOrg } })
    const o2 = await getDashboardOverview()
    if (o2.role !== "venue_owner") throw new Error("expected the venue overview")
    expect(o2.utilisation[2][3]).toBe(1)
    expect(o2.utilisation[3][0]).toBe(0)
  })
})

describe("GAP over licence with a quiet room beside a busy one", () => {
  it("GAP-X18 says over licence when one range's floor proves it, even with a room under 5 in the building", async () => {
    const id = await venue({ ownerOrg })
    const fill = async (n: number) => {
      const night = await realEvent(id, { startsInMin: -30, link: "confirmed" })
      const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: night } })
      for (let i = 0; i < n; i++) {
        const p = await person(`vo_gapq${i}`)
        await db.presence_sessions.create({ data: { event_id: night, occurrence_id: occ.id, user_id: p.id, arrived_at: new Date(Date.now() - 10 * 60_000) } })
      }
    }
    await fill(22) // reads "20+"
    await fill(2) // reads "quiet"
    const asOwner = { asOwner: { id: ownerUser, orgIds: [ownerOrg] } }
    await db.venues.update({ where: { id }, data: { capacity: 15 } })
    const flagged = await getBuildingOccupancy(id, asOwner)
    expect(flagged.rooms.map((r) => r.inside).sort()).toEqual(["20+", "quiet"])
    expect(flagged.overCapacity).toBe(true) // 20 is shown, and 20 > 15
    await db.venues.update({ where: { id }, data: { capacity: 20 } })
    expect((await getBuildingOccupancy(id, asOwner)).overCapacity).toBe(false) // 20 is not over 20
  })
})
