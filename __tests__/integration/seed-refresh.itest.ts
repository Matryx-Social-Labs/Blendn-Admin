import { refreshSeededEvent } from "../../scripts/seed-occurrences"

import { db, closeDb, makeUser, makeEvent, testId } from "./helpers"

/**
 * `--refresh-times` re-times the seeded events and nothing else (SCRUM-482).
 *
 * `seed-blr-scenarios --apply` soft-deletes every other Bengaluru event,
 * seed-qa's included. The refresh found its rows by slug alone, so it went on
 * moving the deleted ones, writing them occurrences, reopening their rooms and
 * printing them as live: for three days every session that followed TEST-PLAN
 * §4 got "Founders & Filter Coffee is live" and a live event nobody could see.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) {
    await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
    await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

const HOUR = 60 * 60 * 1000
const soon = () => ({ start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 2 * HOUR) })

/**
 * A seeded event whose room the archive sweep closed: one member it moved to
 * `left`, and one banned before the close, which the sweep leaves alone.
 */
async function seeded(overrides: { deleted_at?: Date | null } = {}) {
  const owner = await makeUser(testId("refresh_owner"), "organizer")
  const member = await makeUser(testId("refresh_member"))
  const banned = await makeUser(testId("refresh_banned"))
  users.push(owner, member, banned)
  const eventId = await makeEvent(owner, overrides)
  events.push(eventId)
  const { slug, start_time } = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { slug: true, start_time: true } })
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "archived" }, select: { id: true } })
  await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: member, status: "left" } })
  await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: banned, status: "banned" } })
  return { eventId, slug, start_time, roomId: room.id }
}

const roomState = (roomId: string) =>
  db.chat_groups.findUniqueOrThrow({
    where: { id: roomId },
    select: { status: true, members: { select: { status: true }, orderBy: { status: "asc" } } },
  })

const CLOSED = { status: "archived", members: [{ status: "banned" }, { status: "left" }] }

describe("refreshSeededEvent", () => {
  it("leaves a soft-deleted event alone and says so", async () => {
    const { eventId, slug, start_time, roomId } = await seeded({ deleted_at: new Date() })
    const sync = jest.fn(async () => {})

    const result = await refreshSeededEvent(db, slug, soon(), sync)

    expect(result).toEqual({ status: "deleted" })
    expect(sync).not.toHaveBeenCalled()
    const after = await db.events.findUniqueOrThrow({ where: { id: eventId }, select: { start_time: true } })
    expect(after.start_time).toEqual(start_time)
    expect(await roomState(roomId)).toEqual(CLOSED)
  })

  it("moves a live seeded event, syncs its days and reopens its room, and nobody else's", async () => {
    const { eventId, slug, roomId } = await seeded()
    const other = await seeded()
    const when = { ...soon(), data: { cover_image_url: "https://example.invalid/cover.jpg" } }
    const sync = jest.fn(async () => {})

    const result = await refreshSeededEvent(db, slug, when, sync)

    expect(result).toEqual({ status: "moved", eventId, reopened: true })
    expect(sync).toHaveBeenCalledWith({ id: eventId, timezone: "UTC" })
    const after = await db.events.findUniqueOrThrow({
      where: { id: eventId },
      select: { start_time: true, end_time: true, cover_image_url: true },
    })
    expect(after).toEqual({ start_time: when.start, end_time: when.end, cover_image_url: when.data.cover_image_url })
    // The ban stays: the sweep never lifted it, so neither does the reopen.
    expect(await roomState(roomId)).toEqual({ status: "active", members: [{ status: "active" }, { status: "banned" }] })
    expect(await roomState(other.roomId)).toEqual(CLOSED)
  })

  it("keeps an archived room closed when the new end is already past", async () => {
    const { slug, roomId } = await seeded()
    const past = { start: new Date(Date.now() - 3 * HOUR), end: new Date(Date.now() - HOUR) }

    const result = await refreshSeededEvent(db, slug, past, async () => {})

    expect(result).toMatchObject({ status: "moved", reopened: false })
    expect(await roomState(roomId)).toEqual(CLOSED)
  })

  it("reports a slug that was never seeded", async () => {
    expect(await refreshSeededEvent(db, testId("never_seeded"), soon(), async () => {})).toEqual({ status: "missing" })
  })
})
