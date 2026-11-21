import { db, closeDb, makeUser, makeEvent, cleanup } from "./helpers"
import { eventMediaRows } from "@/lib/event-media"
import { eventListSelect } from "@/lib/services/events.service"

/**
 * Media size on `event_media` (SCRUM-1066), against real Postgres: the rows
 * the write routes build land, the list select hands them to the app, and the
 * shape checks in the migration refuse what the app must never write. The
 * checks exist only in migration SQL, so only a db:migrate database has them.
 */
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await cleanup(users, events)
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
        ]),
      },
    },
  })

  const listed = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: eventListSelect })
  expect(listed.media).toEqual([
    expect.objectContaining({ type: "video", width: 1080, height: 1920, duration_ms: 12_400, order: 0 }),
    expect.objectContaining({ type: "image", width: 2048, height: 1536, duration_ms: null, order: 1 }),
    expect.objectContaining({ type: "image", width: null, height: null, duration_ms: null, order: 2 }),
  ])
})

describe("the database refuses a size the app must never write", () => {
  const refused = async (data: { type: "image" | "video"; width?: number; height?: number; duration_ms?: number }) => {
    const eventId = await anEvent()
    await expect(
      db.event_media.create({ data: { event_id: eventId, url: "https://media.example.com/x", ...data } })
    ).rejects.toThrow(/event_media_(size_both|duration_on_video)/)
  }

  it("a width without a height", () => refused({ type: "image", width: 100 }))
  it("a zero side", () => refused({ type: "image", width: 0, height: 100 }))
  it("a length on a still", () => refused({ type: "image", duration_ms: 3000 }))
  it("a zero length", () => refused({ type: "video", duration_ms: 0 }))
})
