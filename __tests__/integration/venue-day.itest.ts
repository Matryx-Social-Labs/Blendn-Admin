import { SYSTEM_USER_ID, VENUE_DAY_INDEX, venueDayBounds, venueDayFor } from "@/lib/venue-day"

import { db as appDb } from "@/lib/db"

import { closeDb, db, makeUser, testId } from "./helpers"

/**
 * The venue day as Postgres holds it (step 3, plan v2 §3).
 *
 * Every rule here lives in the database or depends on it: the partial unique
 * index exists only in migration SQL (a `db push` database has none, so PL-I02
 * passes there for the wrong reason), the system user is a row the migration
 * writes, and its deletion is refused by a trigger. Built with `db:migrate`.
 */

const venues: string[] = []
const users: string[] = []
const orgs: string[] = []

afterAll(async () => {
  const days = await db.events.findMany({ where: { venue_id: { in: venues } }, select: { id: true } })
  const ids = days.map((d) => d.id)
  await db.event_check_ins.deleteMany({ where: { event_id: { in: ids } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: ids } } })
  await db.events.deleteMany({ where: { id: { in: ids } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function venue(data: { claimedAt?: Date; geofence?: object | null; status?: "active" | "archived" } = {}) {
  let owner_org_id: string | null = null
  if (data.claimedAt) {
    const org = await db.organisations.create({ data: { display_name: testId("vd_org"), kind: "company", status: "verified" } })
    orgs.push(org.id)
    owner_org_id = org.id
  }
  const row = await db.venues.create({
    data: {
      name: testId("Venue"),
      city: "Bengaluru",
      latitude: 12.9716,
      longitude: 77.5946,
      ...(data.geofence !== null && { geofence: data.geofence ?? { type: "circle", lat: 12.9716, lng: 77.5946, radius: 60 } }),
      owner_org_id,
      claimed_at: data.claimedAt ?? null,
      status: data.status ?? "active",
    },
  })
  venues.push(row.id)
  return row.id
}

describe("venueDayFor", () => {
  it("makes one row per venue per local day, owned by the system user, never listed", async () => {
    const id = await venue()
    // 01:00 IST on 2 Oct is still the day that began at 06:00 IST on 1 Oct.
    const day = await venueDayFor(id, new Date("2026-10-01T19:30:00Z"))
    expect(day).not.toBeNull()

    const row = await db.events.findUniqueOrThrow({ where: { id: day!.id } })
    expect(row).toMatchObject({
      kind: "venue_day",
      venue_id: id,
      organizer_id: SYSTEM_USER_ID,
      organizer_org_id: null,
      curated_at: null,
      status: "published",
      visibility: "unlisted",
      timezone: "Asia/Kolkata",
    })
    expect(row.start_time.toISOString()).toBe("2026-10-01T00:30:00.000Z")
    expect(row.end_time.toISOString()).toBe("2026-10-02T00:30:00.000Z")
    expect(row.title.startsWith("Venue day · ")).toBe(true)
    // The venue's area, copied (owner's ruling 3).
    expect(row.geofence).toMatchObject({ type: "circle", radius: 60 })
    // An occurrence, as every event has, so check-ins can hang off it.
    const occurrence = await db.event_occurrences.findUniqueOrThrow({ where: { id: day!.occurrenceId } })
    expect(occurrence.event_id).toBe(day!.id)

    // Later the same local day: the same row.
    expect((await venueDayFor(id, new Date("2026-10-02T00:29:00Z")))!.id).toBe(day!.id)
    // 06:00 IST: a new one.
    expect((await venueDayFor(id, new Date("2026-10-02T00:30:00Z")))!.id).not.toBe(day!.id)
  })

  it("survives a race: ten at once write one row and all ten get it (PL-I01, at the library)", async () => {
    const id = await venue()
    const now = new Date("2026-10-03T12:00:00Z")
    const results = await Promise.all(Array.from({ length: 10 }, () => venueDayFor(id, now)))
    expect(new Set(results.map((r) => r!.id)).size).toBe(1)
    expect(await db.events.count({ where: { venue_id: id, kind: "venue_day" } })).toBe(1)
  })

  it("reads the winner when it loses the race, every time (the lost-race path, forced)", async () => {
    // Ten at once only sometimes lose a race; this always does. The day
    // exists, the lookup is made to miss once, so the insert collides on the
    // index and the recovery has to find the winner by re-reading.
    const id = await venue()
    const now = new Date("2026-10-09T12:00:00Z")
    const winner = await venueDayFor(id, now)
    const spy = jest.spyOn(appDb.events, "findFirst").mockResolvedValueOnce(null)
    try {
      expect((await venueDayFor(id, now))!.id).toBe(winner!.id)
    } finally {
      spy.mockRestore()
    }
    expect(await db.events.count({ where: { venue_id: id, kind: "venue_day" } })).toBe(1)
  })

  it("gives two venues on the same day two rows, each carrying its own venue", async () => {
    const [a, b] = [await venue(), await venue()]
    const now = new Date("2026-10-10T12:00:00Z")
    const [dayA, dayB] = [await venueDayFor(a, now), await venueDayFor(b, now)]
    expect(dayA!.id).not.toBe(dayB!.id)
    const rowA = await db.events.findUniqueOrThrow({ where: { id: dayA!.id } })
    const venueA = await db.venues.findUniqueOrThrow({ where: { id: a } })
    expect(rowA).toMatchObject({
      venue_name: venueA.name,
      city: "Bengaluru",
      latitude: venueA.latitude,
      longitude: venueA.longitude,
      address: venueA.address,
    })
    expect(rowA.title).toBe(`Venue day · ${venueA.name} · 2026-10-10`)
  })

  it("names the occurrence by the venue's date, not UTC's, and makes a 25-hour day where the clocks go back", async () => {
    const auckland = await venue()
    await db.venues.update({ where: { id: auckland }, data: { timezone: "Pacific/Auckland" } })
    // 07:00 NZDT on 11 Oct is 18:00Z on 10 Oct.
    const nz = await venueDayFor(auckland, new Date("2026-10-10T18:00:00Z"))
    const occurrence = await db.event_occurrences.findUniqueOrThrow({ where: { id: nz!.occurrenceId } })
    expect(occurrence.occurs_on.toISOString().slice(0, 10)).toBe("2026-10-11")

    const berlin = await venue()
    await db.venues.update({ where: { id: berlin }, data: { timezone: "Europe/Berlin" } })
    const fallBack = await venueDayFor(berlin, new Date("2026-10-24T22:00:00Z"))
    expect(fallBack!.end_time.getTime() - fallBack!.start_time.getTime()).toBe(25 * 3_600_000)
  })

  it("makes nothing for a deleted venue", async () => {
    const id = await venue()
    await db.venues.update({ where: { id }, data: { deleted_at: new Date() } })
    expect(await venueDayFor(id)).toBeNull()
  })

  it("is held to one per day by the database, not only by the code (PL-I02)", async () => {
    const id = await venue()
    const day = await venueDayFor(id, new Date("2026-10-04T12:00:00Z"))
    const row = await db.events.findUniqueOrThrow({ where: { id: day!.id } })

    const insert = db.$executeRaw`
      INSERT INTO events (id, slug, title, description, start_time, end_time, timezone, organizer_id, venue_id, kind, updated_at)
      VALUES (gen_random_uuid(), ${testId("dup")}, 'dup', '', ${row.start_time}, ${row.end_time}, 'UTC', ${SYSTEM_USER_ID}, ${id}, 'venue_day', now())`
    await expect(insert).rejects.toMatchObject({ code: "P2010" })
    await insert.catch((e: unknown) => expect(JSON.stringify(e)).toContain(VENUE_DAY_INDEX))

    // Partial: two events at the same venue and the same minute are nobody's business.
    for (const label of ["a", "b"]) {
      const e = await db.events.create({
        data: { slug: testId(`same_${label}`), title: "x", description: "", start_time: row.start_time, end_time: row.end_time, timezone: "UTC", organizer_id: SYSTEM_USER_ID, venue_id: id },
      })
      await db.events.delete({ where: { id: e.id } }).catch(() => undefined)
    }
  })

  it("gives a claimed venue's days to its org from the claim on, never the day the claim fell in", async () => {
    const claimedAt = new Date("2026-10-05T08:30:00Z") // 14:00 IST
    const id = await venue({ claimedAt })
    const owner = (await db.venues.findUniqueOrThrow({ where: { id } })).owner_org_id

    const claimDay = await venueDayFor(id, new Date("2026-10-05T10:00:00Z"))
    const nextDay = await venueDayFor(id, new Date("2026-10-06T10:00:00Z"))
    const rows = await db.events.findMany({ where: { id: { in: [claimDay!.id, nextDay!.id] } }, select: { id: true, organizer_org_id: true } })
    const orgOf = new Map(rows.map((r) => [r.id, r.organizer_org_id]))
    expect(orgOf.get(claimDay!.id)).toBeNull()
    expect(orgOf.get(nextDay!.id)).toBe(owner)
  })

  it("makes a day with no area for a venue with none, and nothing for an archived venue", async () => {
    const bare = await venue({ geofence: null })
    const day = await venueDayFor(bare, new Date("2026-10-07T12:00:00Z"))
    expect((await db.events.findUniqueOrThrow({ where: { id: day!.id } })).geofence).toBeNull()

    expect(await venueDayFor(await venue({ status: "archived" }))).toBeNull()
    expect(await venueDayFor("00000000-0000-4000-8000-000000000000")).toBeNull()
  })

  it("counts the day in the venue's own zone and reset hour", async () => {
    const id = await venue()
    await db.venues.update({ where: { id }, data: { timezone: "Europe/Berlin", day_reset_hour: 5 } })
    const day = await venueDayFor(id, new Date("2026-10-08T02:00:00Z")) // 04:00 CEST: yesterday's
    const row = await db.events.findUniqueOrThrow({ where: { id: day!.id } })
    expect(row.start_time.toISOString()).toBe("2026-10-07T03:00:00.000Z")
    expect(row.timezone).toBe("Europe/Berlin")
  })

  it("refuses a zone either side cannot read, and an hour off the clock", async () => {
    const id = await venue()
    const set = (data: { timezone?: string; day_reset_hour?: number }) =>
      db.$executeRawUnsafe(
        `UPDATE venues SET ${Object.keys(data)[0]} = $1 WHERE id = $2::uuid`,
        Object.values(data)[0],
        id
      )
    await expect(set({ timezone: "Mars/Olympus_Mons" })).rejects.toThrow(/not recognized/)
    // Postgres reads these and Node does not: the shape check refuses them.
    await expect(set({ timezone: "UTC+5" })).rejects.toThrow(/venues_timezone_known/)
    await expect(set({ timezone: "<+05>-5" })).rejects.toThrow(/venues_timezone_known/)
    await expect(set({ day_reset_hour: 24 })).rejects.toThrow(/venues_day_reset_hour_range/)
    await expect(set({ day_reset_hour: -1 })).rejects.toThrow(/venues_day_reset_hour_range/)
    await set({ day_reset_hour: 0 })
    await set({ timezone: "America/Argentina/Buenos_Aires" })
    await set({ timezone: "UTC" })
    expect(() => venueDayBounds("UTC+5", 6, new Date())).toThrow(RangeError)
  })
})

/*
 * F2 / PL-I12: deleting a person never takes the day with it. The owner is the
 * system user, and the system user cannot be deleted.
 */
describe("who owns a venue day", () => {
  it("keeps the day, and everybody else's check-in, when the person who went live first is deleted", async () => {
    const id = await venue()
    const day = await venueDayFor(id, new Date())
    const first = await makeUser("vd_first")
    const second = await makeUser("vd_second")
    users.push(second)
    for (const user_id of [first, second]) {
      await db.event_check_ins.create({
        data: { event_id: day!.id, occurrence_id: day!.occurrenceId, user_id, status: "checked_in", check_in_time: new Date() },
      })
    }

    await db.user.delete({ where: { id: first } })

    expect(await db.events.findUnique({ where: { id: day!.id }, select: { id: true } })).not.toBeNull()
    expect(await db.event_check_ins.count({ where: { event_id: day!.id } })).toBe(1)
  })

  it("refuses to delete the system user, so no deletion can cascade every venue day", async () => {
    const day = await venueDayFor(await venue(), new Date())
    // The trigger raises restrict_violation, which Prisma reports as a foreign
    // key failure; what matters is that nothing went.
    await expect(db.user.delete({ where: { id: SYSTEM_USER_ID } })).rejects.toMatchObject({ code: "P2003" })
    await expect(db.user.deleteMany({ where: { id: { in: [SYSTEM_USER_ID] } } })).rejects.toThrow()
    await expect(db.$executeRaw`DELETE FROM "User" WHERE id = ${SYSTEM_USER_ID}`).rejects.toThrow(/cannot be deleted/)
    expect(await db.user.findUnique({ where: { id: SYSTEM_USER_ID }, select: { id: true } })).not.toBeNull()
    expect(await db.events.findUnique({ where: { id: day!.id }, select: { id: true } })).not.toBeNull()
  })

  it("is a user nobody can sign in as", async () => {
    const system = await db.user.findUniqueOrThrow({ where: { id: SYSTEM_USER_ID } })
    expect(system).toMatchObject({ role: "attendee", password: null, email: "system@blendn.invalid" })
    expect(await db.profiles.findUnique({ where: { id: SYSTEM_USER_ID } })).toBeNull()
  })
})
