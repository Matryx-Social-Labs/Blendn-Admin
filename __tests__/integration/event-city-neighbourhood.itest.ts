/*
 * SCRUM-1038, through the real routes and the migrated catalogue: an event saved with a neighbourhood as its city
 * ("Koramangala") at a pin inside Bengaluru is stored as Bengaluru, so "Where Blend'n is on" never lists the
 * neighbourhood as a city of its own. Controls: a catalogue city keeps its spelling, and a city we do not serve keeps
 * its name.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
// No geocoder in a test: a typed city is resolved as typed, which is the path the defect came in by.
jest.mock("@/lib/location", () => ({
  ...jest.requireActual("@/lib/location"),
  resolveEventCity: async (city: string | null | undefined) => city ?? null,
}))

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let host: string
let orgId: string

beforeAll(async () => {
  host = await makeUser(testId("ecn-host"), "organizer")
  users.push(host)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("ecn-org"), status: "verified" } })
  orgs.push(org.id)
  orgId = org.id
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
})

afterAll(async () => {
  const mine = await db.events.findMany({ where: { organizer_id: host }, select: { id: true } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: [...events, ...mine.map((e) => e.id)] } } })
  await db.events.deleteMany({ where: { id: { in: [...events, ...mine.map((e) => e.id)] } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

const KORAMANGALA = { latitude: 12.9346, longitude: 77.6269 }

async function create(city: string, at: { latitude: number; longitude: number }) {
  const res = await eventsRoute.POST(
    new Request("http://localhost/api/events", {
      method: "POST",
      body: JSON.stringify({
        title: testId("ecn-event"),
        description: "integration fixture",
        start_time: new Date(Date.now() + 86_400_000).toISOString(),
        end_time: new Date(Date.now() + 90_000_000).toISOString(),
        timezone: "Asia/Kolkata",
        city,
        ...at,
      }),
    }) as never
  )
  const body = await res.json()
  expect(res.status).toBe(200)
  const id = (body.data?.id ?? body.data?.event?.id ?? body.id) as string
  events.push(id)
  return (await db.events.findUniqueOrThrow({ where: { id }, select: { city: true } })).city
}

it("POST stores a neighbourhood typed as the city as the catalogue city at its pin", async () => {
  expect(await create("Koramangala", KORAMANGALA)).toBe("Bengaluru")
})

it("POST keeps a catalogue city as spelt, and a city we do not serve as named (controls)", async () => {
  expect(await create("Bangalore", KORAMANGALA)).toBe("Bangalore")
  expect(await create("Saarbrücken", { latitude: 49.2402, longitude: 6.9969 })).toBe("Saarbrücken")
})

it("PATCH folds a typed neighbourhood with the pin unmoved, by the event's own pin", async () => {
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: orgId, city: "Bengaluru", ...KORAMANGALA } })
  const res = await eventRoute.PATCH(
    new Request(`http://localhost/api/events/${eventId}`, { method: "PATCH", body: JSON.stringify({ city: "Malleshwaram" }) }),
    { params: Promise.resolve({ id: eventId }) }
  )
  expect(res.status).toBe(200)
  expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).city).toBe("Bengaluru")
})
