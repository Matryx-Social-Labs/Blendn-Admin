import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, makeEvent, cleanup, testId } from "./helpers"
import { eventMediaRows } from "@/lib/event-media"
import { eventListSelect } from "@/lib/services/events.service"

/**
 * Media size on `event_media` (SCRUM-1066), against real Postgres: the rows
 * the write routes build land, the list select hands them to the app, and the
 * shape checks in the migration refuse what the app must never write. The
 * checks exist only in migration SQL, so only a db:migrate database has them.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const detailRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const orgs: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function anEvent() {
  const organizer = await makeUser("media-size", "organizer")
  users.push(organizer)
  const eventId = await makeEvent(organizer)
  events.push(eventId)
  return eventId
}

it("writes the measured size and length, and the list sends them", async () => {
  const eventId = await anEvent()
  await db.events.update({
    where: { id: eventId },
    data: {
      media: {
        create: eventMediaRows([
          { type: "video", url: "https://media.example.com/c.mp4", width: 1080, height: 1920, duration_ms: 12_400 },
          { type: "image", url: "https://media.example.com/a.jpg", width: 2048, height: 1536, duration_ms: 99 },
          { type: "image", url: "https://media.example.com/pasted.jpg" },
          { type: "video", url: "https://media.example.com/f.mp4", focal_x: 0.62, focal_y: 0.25 },
        ]),
      },
    },
  })

  const listed = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: eventListSelect })
  expect(listed.media).toEqual([
    expect.objectContaining({ type: "video", width: 1080, height: 1920, duration_ms: 12_400, order: 0 }),
    expect.objectContaining({ type: "image", width: 2048, height: 1536, duration_ms: null, order: 1 }),
    expect.objectContaining({ type: "image", width: null, height: null, duration_ms: null, focal_x: null, focal_y: null, order: 2 }),
    expect.objectContaining({ type: "video", focal_x: 0.62, focal_y: 0.25, order: 3 }),
  ])
})

describe("the database refuses a size the app must never write", () => {
  const refused = async (data: {
    type: "image" | "video"
    width?: number
    height?: number
    duration_ms?: number
    focal_x?: number
    focal_y?: number
  }) => {
    const eventId = await anEvent()
    await expect(
      db.event_media.create({ data: { event_id: eventId, url: "https://media.example.com/x", ...data } })
    ).rejects.toThrow(/event_media_(size_both|duration_on_video|focal_both)/)
  }

  it("a width without a height", () => refused({ type: "image", width: 100 }))
  it("a zero side", () => refused({ type: "image", width: 0, height: 100 }))
  it("a length on a still", () => refused({ type: "image", duration_ms: 3000 }))
  it("a zero length", () => refused({ type: "video", duration_ms: 0 }))
  it("half a focal point", () => refused({ type: "video", focal_x: 0.5 }))
  it("a focal point past the edge", () => refused({ type: "video", focal_x: 1.2, focal_y: 0.5 }))
  it("a focal point before the edge", () => refused({ type: "image", focal_x: 0.5, focal_y: -0.1 }))
})

describe("from the dashboard's save to the app's detail", () => {
  async function ownedEvent() {
    const host = await makeUser("media-host", "organizer")
    users.push(host)
    const org = await db.organisations.create({ data: { kind: "company", display_name: testId("media-org"), status: "verified" } })
    orgs.push(org.id)
    await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
    mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
    return eventId
  }

  const save = (eventId: string, media_items: unknown[]) =>
    eventRoute.PATCH(
      new Request(`http://localhost/api/events/${eventId}`, { method: "PATCH", body: JSON.stringify({ media_items }) }),
      { params: Promise.resolve({ id: eventId }) }
    )

  const clip = {
    type: "video",
    url: "https://media.example.com/c.mp4",
    width: 1080,
    height: 1920,
    duration_ms: 15_200,
    focal_x: 0.62,
    focal_y: 0.25,
  }

  it("PATCH writes the size and GET /events/:id sends it in camelCase", async () => {
    const eventId = await ownedEvent()
    expect((await save(eventId, [clip])).status).toBe(200)

    const viewer = await makeUser("media-viewer")
    users.push(viewer)
    await db.profiles.create({ data: { id: viewer, onboarded: true } })
    const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
    const res = await detailRoute.GET(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}`, {
        headers: { authorization: `Bearer ${signAccessToken(viewer, email)}` },
      }),
      { params: Promise.resolve({ eventId }) }
    )
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.media).toEqual([
      expect.objectContaining({ type: "video", width: 1080, height: 1920, durationMs: 15_200, focalX: 0.62, focalY: 0.25 }),
    ])
  })

  it("PATCH refuses a clip past the tolerance and leaves the rows that were there", async () => {
    const eventId = await ownedEvent()
    expect((await save(eventId, [clip])).status).toBe(200)
    expect((await save(eventId, [{ ...clip, duration_ms: 20_000 }])).status).toBe(400)
    expect(await db.event_media.findMany({ where: { event_id: eventId }, select: { duration_ms: true } })).toEqual([
      { duration_ms: 15_200 },
    ])
  })

  it("PATCH refuses half a focal point and leaves the rows that were there", async () => {
    const eventId = await ownedEvent()
    expect((await save(eventId, [clip])).status).toBe(200)
    expect((await save(eventId, [{ ...clip, focal_y: null }])).status).toBe(400)
    expect(await db.event_media.findMany({ where: { event_id: eventId }, select: { focal_x: true, focal_y: true } })).toEqual([
      { focal_x: 0.62, focal_y: 0.25 },
    ])
  })

  it("PATCH with no session is 401 and writes nothing", async () => {
    const eventId = await ownedEvent()
    mockGetAuth.mockResolvedValue(null)
    expect((await save(eventId, [clip])).status).toBe(401)
    expect(await db.event_media.count({ where: { event_id: eventId } })).toBe(0)
  })

  it("POST writes the size with a new event", async () => {
    await ownedEvent()
    const title = testId("media-new")
    const res = await eventsRoute.POST(
      new Request("http://localhost/api/events", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: "integration fixture",
          start_time: new Date(Date.now() + 86_400_000).toISOString(),
          end_time: new Date(Date.now() + 90_000_000).toISOString(),
          timezone: "Asia/Kolkata",
          media_items: [clip],
        }),
      }) as never
    )
    expect(res.status).toBeLessThan(300)
    const created = await db.events.findFirstOrThrow({ where: { title }, select: { id: true, media: true } })
    events.push(created.id)
    expect(created.media).toEqual([
      expect.objectContaining({ width: 1080, height: 1920, duration_ms: 15_200, focal_x: 0.62, focal_y: 0.25 }),
    ])
  })
})
