import type { DashboardRole } from "@/lib/dashboard-types"

import { NextRequest } from "next/server"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * Removing a drawn fence actually removes it.
 *
 * ## Why this needs real Postgres
 *
 * `events.geofence` is `Json?`, and Prisma **refuses a bare `null`** on a
 * nullable Json column at the type level: it cannot distinguish "set the column
 * to SQL NULL" from "store the JSON value null". Clearing one needs
 * `Prisma.DbNull`.
 *
 * That is why this was never merely forgotten. `validateLocationInput` sets
 * `values.geofence = null` deliberately, commented "Explicit null clears it and
 * falls back to the point + radius columns" — and the route then wrote
 * `...(geofence != null && { geofence })`, dropping precisely that value.
 * `tsc` rejects the obvious fix, so dropping the null is what somebody does
 * next, and the two halves are each defensible in isolation.
 *
 * The symptom is silent and the wrong way round: the PATCH succeeds, the
 * response looks correct, and the door goes on testing against a shape that is
 * no longer on the organiser's screen. Nobody finds out until an attendee is
 * refused standing in the right place.
 *
 * A mocked-`db` unit test could only assert the argument shape. Whether
 * `DbNull` clears the column is a question about Postgres, so it is asked here.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/events/[id]/route") as
  typeof import("@/app/api/events/[id]/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

/*
 * The shape `lib/geofence.ts` actually defines — flat, with an explicit
 * `buffer`. The first draft of this fixture used `{ center: { lat, lng } }`,
 * which the app never writes; because the fixture is inserted directly it was
 * accepted, and three tests passed against a fence shaped like nothing in
 * production. The replacement-fence test 400ing is what exposed it, since that
 * one goes through `validateGeofence` and the others do not.
 */
const FENCE = {
  type: "circle" as const,
  lat: 12.9784,
  lng: 77.6408,
  radius: 120,
  buffer: 20,
}

afterAll(async () => {
  if (events.length) await db.events.deleteMany({ where: { id: { in: events } } })
  await cleanup(users, [])
  await closeDb()
})

async function fencedEvent() {
  const owner = await makeUser(testId("gf_own"), "app_admin")
  users.push(owner)
  session = { user: { id: owner, role: "app_admin" } }

  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("gf"),
      title: `Fenced ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now + HOUR),
      end_time: new Date(now + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
      latitude: FENCE.lat,
      longitude: FENCE.lng,
      geofence: FENCE,
    },
  })
  events.push(event.id)
  return event.id
}

const patch = (id: string, body: Record<string, unknown>) =>
  eventRoute.PATCH(
    new NextRequest(`http://localhost/api/events/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )

describe("clearing a geofence", () => {
  it("is stored as a fence in the first place", async () => {
    // The control. Every assertion below is about a fence going away, which is
    // trivially true of an event that never had one.
    const id = await fencedEvent()
    const row = await db.events.findUniqueOrThrow({
      where: { id },
      select: { geofence: true },
    })
    expect(row.geofence).toMatchObject({ type: "circle", radius: 120 })
  })

  it("an explicit null clears the column", async () => {
    const id = await fencedEvent()

    const res = await patch(id, { geofence: null })
    expect(res.status).toBe(200)

    const row = await db.events.findUniqueOrThrow({
      where: { id },
      select: { geofence: true, latitude: true, longitude: true },
    })

    expect({
      geofence: row.geofence,
      hint: row.geofence !== null ? "The fence survived the request that removed it." : "",
    }).toEqual({ geofence: null, hint: "" })

    /*
     * SQL NULL, not the JSON scalar `null`, and this assertion exists because
     * the recorded control could not tell them apart without it.
     *
     * Swapping `Prisma.DbNull` for `Prisma.JsonNull` left every assertion above
     * green: both read back as JS `null` through the client, so the test agreed
     * the fence was gone while the column held a JSON `null` and
     * `geofence IS NULL` was **false**. Anything filtering on `IS NULL` — a
     * `where: { geofence: null }`, a migration, a raw report — would then have
     * treated a cleared event as still fenced.
     *
     * Asked in SQL because that is the only place the difference is visible.
     */
    const [{ is_sql_null }] = await db.$queryRaw<Array<{ is_sql_null: boolean }>>`
      SELECT geofence IS NULL AS is_sql_null FROM events WHERE id = ${id}::uuid
    `
    expect({
      is_sql_null,
      hint: is_sql_null ? "" : "The column holds a JSON null rather than SQL NULL.",
    }).toEqual({ is_sql_null: true, hint: "" })

    // And it falls back to the point, rather than leaving the event with no
    // location at all — which is what `validateLocationInput` promises and what
    // makes clearing safe on a published event.
    expect(row.latitude).toBeCloseTo(FENCE.lat)
    expect(row.longitude).toBeCloseTo(FENCE.lng)
  })

  it("an omitted geofence leaves it alone", async () => {
    /*
     * The other half of the distinction, and the reason the fix is `in` rather
     * than a null check: a PATCH that only changes the title must not remove
     * the fence. If absent and null were collapsed the other way, every edit
     * would clear it.
     */
    const id = await fencedEvent()

    const res = await patch(id, { title: "Renamed, fence untouched" })
    expect(res.status).toBe(200)

    const row = await db.events.findUniqueOrThrow({
      where: { id },
      select: { geofence: true, title: true },
    })
    expect(row.title).toBe("Renamed, fence untouched")
    expect(row.geofence).toMatchObject({ type: "circle", radius: 120 })
  })

  it("a replacement fence is written", async () => {
    const id = await fencedEvent()

    const res = await patch(id, {
      geofence: { type: "circle", lat: 12.95, lng: 77.6, radius: 300, buffer: 10 },
    })
    expect(res.status).toBe(200)

    const row = await db.events.findUniqueOrThrow({
      where: { id },
      select: { geofence: true },
    })
    expect(row.geofence).toMatchObject({ radius: 300 })
  })
})
