/**
 * SCRUM-1146: the `organizer` the app reads is the organisation, never the user who created the row. Real handlers,
 * real rows: a curated event (created by an admin), an org event (created by a member), on the saved list and the
 * event read. No response may carry the creating user's id, name or image.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"
import { eventListSelect, transformEvents } from "@/lib/services/events.service"
import { cleanupWorld, eventParams, person, req, routes, world } from "./go-live-world"
import { closeDb, db, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const favoritesRoute = require("@/app/api/mobile/users/[userId]/favorites/route") as typeof import("@/app/api/mobile/users/[userId]/favorites/route")

const HOUR = 3_600_000
const CREATOR_NAME = "Itest Creator Realname"
const CREATOR_IMAGE = "https://cdn.itest.invalid/creator.jpg"
const events: string[] = []

afterAll(async () => {
  await db.event_favorites.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await cleanupWorld()
  await closeDb()
})

async function publishedEvent(label: string, creator: string, data: { organizer_org_id?: string; curated_at?: Date }) {
  const start = new Date(Date.now() + 30 * HOUR)
  const row = await db.events.create({
    data: {
      slug: testId(label),
      title: `${label} ${testId("t")}`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: creator,
      venue_name: "The Old Room",
      address: "1 Church St",
      city: "Bengaluru",
      latitude: 12.97,
      longitude: 77.59,
      ...data,
    },
  })
  events.push(row.id)
  return row.id
}

describe("organizer on the app's event reads is the org, never the creating user", () => {
  let me: { id: string; token: string }
  let creator = ""
  let orgId = ""
  let orgName = ""
  let curated = ""
  let orgEvent = ""
  let personal = ""

  beforeAll(async () => {
    me = await person("hp_me")
    creator = (await person("hp_creator")).id
    await db.user.update({ where: { id: creator }, data: { name: CREATOR_NAME, image: CREATOR_IMAGE } })
    orgName = `HP Org ${testId("o")}`
    orgId = (await db.organisations.create({ data: { display_name: orgName, status: "verified" } })).id
    world.orgs.push(orgId)
    ;[curated, orgEvent, personal] = await Promise.all([
      publishedEvent("hp_curated", creator, { curated_at: new Date() }),
      publishedEvent("hp_org", creator, { organizer_org_id: orgId }),
      publishedEvent("hp_person", creator, {}),
    ])
    for (const id of [curated, orgEvent, personal]) await db.event_favorites.create({ data: { event_id: id, user_id: me.id } })
  })

  const expected = () => ({
    [curated]: { id: null, name: "Blendn", image: null, kind: "platform" },
    [orgEvent]: { id: orgId, name: orgName, image: null, kind: "org" },
    [personal]: { id: null, name: null, image: null, kind: "person" },
  })

  it("/users/:id/favorites", async () => {
    const res = await favoritesRoute.GET(
      new NextRequest(`http://localhost/api/mobile/users/${me.id}/favorites?limit=50`, { headers: { authorization: `Bearer ${me.token}` } }),
      { params: Promise.resolve({ userId: me.id }) }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const rows = Object.fromEntries(body.data.events.map((e: { id: string; organizer: unknown }) => [e.id, e.organizer]))
    expect(rows).toEqual(expected())
    const text = JSON.stringify(body)
    for (const leak of [creator, CREATOR_NAME, CREATOR_IMAGE]) expect(text).not.toContain(leak)
  })

  it("/events rows (transformEvents)", async () => {
    const rows = await db.events.findMany({ where: { id: { in: [curated, orgEvent, personal] } }, select: eventListSelect })
    const out = await transformEvents(rows, { favoriteEventIds: new Set() })
    expect(Object.fromEntries(out.map((e) => [e.id, e.organizer]))).toEqual(expected())
    const text = JSON.stringify(out)
    for (const leak of [creator, CREATOR_NAME, CREATOR_IMAGE]) expect(text).not.toContain(leak)
  })

  it("/events/:id", async () => {
    for (const [id, organizer] of Object.entries(expected())) {
      const res = await routes.event.GET(req(`/api/mobile/events/${id}`, me.token), eventParams(id))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.organizer).toEqual(organizer)
      const text = JSON.stringify(body)
      for (const leak of [creator, CREATOR_NAME, CREATOR_IMAGE]) expect(text).not.toContain(leak)
    }
  })
})
