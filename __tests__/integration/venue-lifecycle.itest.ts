import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/**
 * A venue can be corrected and retired — which it could not, since the table
 * was created.
 *
 * `venues.status` and `venues.deleted_at` have existed all along. Every read
 * filters `deleted_at: null`, `venue_status.archived` was declared, and
 * `@@index([status])` indexed a column that never changed — because **nothing
 * ever wrote either one**. There was no `deleteVenue`, no `archiveVenue`, no
 * retirement path of any kind, and `UpdateVenueInput` carried no coordinates,
 * so a venue's pin was write-once at creation.
 *
 * That matters more for a place than for an event. An event's wrong pin is
 * wrong for one night; a venue's is wrong for every event ever held there, and
 * it never ages out, because a place has no end date.
 *
 * Against real Postgres: these assert what the *database* holds after each
 * action, and a mocked client would agree with whatever the code did.
 */

const users: string[] = []
const events: string[] = []
const venues: string[] = []

afterAll(async () => {
  if (venues.length) {
    await db.events.updateMany({ where: { venue_id: { in: venues } }, data: { venue_id: null } })
    await db.venues.deleteMany({ where: { id: { in: venues } } })
  }
  await cleanup(users, events)
  await closeDb()
})

async function venue(overrides: Record<string, unknown> = {}) {
  const row = await db.venues.create({
    data: {
      name: `Venue ${testId("v")}`,
      city: "Bengaluru",
      latitude: 12.97,
      longitude: 77.59,
      ...overrides,
    },
    select: { id: true },
  })
  venues.push(row.id)
  return row.id
}

describe("retiring a venue", () => {
  it("writes both columns, because one without the other is a contradiction", async () => {
    /*
     * `deleted_at` is what every existing read filters on, so it is what
     * actually removes the venue. `status` is set with it because a row saying
     * `active` that no query returns is worse than either state alone — and
     * `venue_status.archived` was unreachable until something wrote it.
     */
    const id = await venue()
    await db.venues.update({
      where: { id },
      data: { deleted_at: new Date(), status: "archived" },
    })

    const row = await db.venues.findUniqueOrThrow({
      where: { id },
      select: { deleted_at: true, status: true },
    })
    expect(row.deleted_at).not.toBeNull()
    expect(row.status).toBe("archived")
  })

  it("keeps the history, because events point here", async () => {
    /*
     * Soft, not hard. `events.venue_id` references this row, so a hard delete
     * either cascades away everything that happened at the place or is refused
     * by the constraint. Retiring a venue must not retire its past.
     */
    const host = await makeUser(testId("vl-host"), "organizer")
    users.push(host)
    const id = await venue()
    const event = await db.events.create({
      data: {
        slug: testId("vl-evt"),
        title: "Past night",
        description: "fixture",
        start_time: new Date(Date.now() - 3 * 60 * 60 * 1000),
        end_time: new Date(Date.now() - 60 * 60 * 1000),
        timezone: "UTC",
        status: "published",
        organizer_id: host,
        venue_id: id,
      },
      select: { id: true },
    })
    events.push(event.id)

    await db.venues.update({
      where: { id },
      data: { deleted_at: new Date(), status: "archived" },
    })

    const still = await db.events.findUniqueOrThrow({
      where: { id: event.id },
      select: { venue_id: true },
    })
    expect(still.venue_id).toBe(id)
  })

  it("disappears from every read that filters on deleted_at", async () => {
    const id = await venue()
    await db.venues.update({ where: { id }, data: { deleted_at: new Date(), status: "archived" } })

    expect(await db.venues.findFirst({ where: { id, deleted_at: null } })).toBeNull()
    // And is still there for the one screen that must reach it — the restore
    // control lives on the detail page, so filtering there would make
    // retirement one-way by accident.
    expect(await db.venues.findUnique({ where: { id } })).not.toBeNull()
  })
})

describe("correcting the pin", () => {
  it("moves both coordinates together", async () => {
    const id = await venue()
    await db.venues.update({ where: { id }, data: { latitude: 19.076, longitude: 72.877 } })

    const row = await db.venues.findUniqueOrThrow({
      where: { id },
      select: { latitude: true, longitude: true },
    })
    expect(row.latitude).toBeCloseTo(19.076, 3)
    expect(row.longitude).toBeCloseTo(72.877, 3)
  })

  it("is what the bounding-box index is for", async () => {
    /*
     * `@@index([latitude, longitude])` exists on `venues`, and until the pin
     * could be corrected it indexed a column nobody could change. Asserted
     * against `pg_indexes` rather than the schema file: `schema.prisma` says
     * what should exist, and this project has already shipped a database
     * missing three constraints the schema could not express.
     */
    const rows = await db.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'venues' AND indexdef LIKE '%latitude%'
    `
    expect(rows.length).toBeGreaterThan(0)
  })
})
