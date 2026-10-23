import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

import { hereCountFor, hereCounts } from "@/lib/attendee-counts"
import { performCheckout } from "@/lib/checkout"
import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/**
 * One room, one number (RC drive 3). The concert room said "Everyone here 482",
 * "515 in the room" and "In the room 450" at once, over 483 people checked in:
 * the Banter's row counted the room's members, and a member row outlives the
 * check-in — checkout and expiry leave it `active` — so it counted everybody
 * who had ever been in. And the Room info list listed them.
 *
 * Every surface now says the Room's number, inside now (`hereCountFor`), and
 * the "In the room" list lists only the people it counts. A checkout takes one
 * off all of them at once, and so does an expiry.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
type Ctx = { params: Promise<Record<string, string>> }
type Handler = (req: NextRequest, ctx: Ctx) => Promise<Response>
const groups = require("@/app/api/mobile/chat/groups/route") as { GET: (req: NextRequest) => Promise<Response> }
const participants = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as { GET: Handler }
const preview = require("@/app/api/mobile/events/[eventId]/room-preview/route") as { GET: Handler }
const detail = require("@/app/api/mobile/events/[eventId]/route") as { GET: Handler }
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

const get = async (handler: Handler, path: string, token: string, params: Record<string, string>) => {
  const res = await handler(new NextRequest(`http://localhost/api/mobile/${path}`, { headers: { authorization: `Bearer ${token}` } }), {
    params: Promise.resolve(params),
  })
  return { status: res.status, json: await res.json() }
}

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return id
}

/**
 * Six inside (the viewer among them), one inside who pressed Leave on the chat,
 * two members who checked out, one whose window expired. `member_count` is a
 * number nobody should read.
 */
async function world() {
  const host = await makeUser(testId("rc_host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const occurrenceId = await occurrenceOf(eventId)
  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active", member_count: 999 } })

  const seat = async (label: string, chat: "active" | "left") => {
    const id = await person(label)
    await putInRoom({ eventId, occurrenceId, userId: id })
    await db.chat_group_members.create({
      data: { chat_group_id: room.id, user_id: id, anonymous_name: testId("Otter"), status: chat, ...(chat === "left" && { left_at: new Date() }) },
    })
    return id
  }
  const viewer = await seat("rc_viewer", "active")
  const inside = [viewer]
  for (let i = 0; i < 5; i++) inside.push(await seat(`rc_in${i}`, "active"))
  await seat("rc_leftchat", "left")
  const gone = [await seat("rc_out0", "active"), await seat("rc_out1", "active"), await seat("rc_expired", "active")]
  for (const [i, id] of gone.entries()) {
    const row = await db.event_check_ins.findFirstOrThrow({ where: { event_id: eventId, user_id: id }, select: { id: true } })
    // An expiry acts only on a window that has ended.
    if (i === 2) await db.event_check_ins.update({ where: { id: row.id }, data: { expires_at: new Date(Date.now() - 1000) } })
    await performCheckout(row.id, i === 2 ? "expired" : "manual")
  }
  return { eventId, roomId: room.id, viewer, inside, token: signAccessToken(viewer, `${viewer}@itest.invalid`) }
}

let w: Awaited<ReturnType<typeof world>>
beforeAll(async () => {
  w = await world()
}, 60_000)

/** Every number a phone can print for this room, as the routes serve them. */
async function everyCount() {
  const list = await groups.GET(new NextRequest("http://localhost/api/mobile/chat/groups", { headers: { authorization: `Bearer ${w.token}` } }))
  const row = ((await list.json()).data.groups as { id: string; hereCount: number; memberCount: number }[]).find((g) => g.id === w.roomId)
  const p = await get(preview.GET, `events/${w.eventId}/room-preview`, w.token, { eventId: w.eventId })
  const d = await get(detail.GET, `events/${w.eventId}`, w.token, { eventId: w.eventId })
  const people = await get(participants.GET, `chat/groups/${w.roomId}/participants?limit=100`, w.token, { chatGroupId: w.roomId })
  return {
    helper: await hereCountFor(w.eventId),
    batched: (await hereCounts([w.eventId])).get(w.eventId),
    rowHere: row?.hereCount,
    rowMembers: row?.memberCount,
    preview: p.json.data.hereCount,
    detailStats: d.json.data.stats.hereCount,
    detailChat: d.json.data.chatGroup.member_count,
    listed: people.json.data.totalCount,
    listedRows: people.json.data.participants.length,
  }
}

describe("one room, one number", () => {
  it("every surface says inside now: not the members who checked out or expired, and still the one who left the chat", async () => {
    // 6 active members inside + 1 inside who left the chat = 7; 3 members out.
    expect(await everyCount()).toEqual({
      helper: 7,
      batched: 7,
      rowHere: 7,
      rowMembers: 7,
      preview: 7,
      detailStats: 7,
      detailChat: 7,
      // The list: inside AND in the chat. The one who pressed Leave is counted, not listed.
      listed: 6,
      listedRows: 6,
    })
  })

  it("a checkout takes one off every surface at once", async () => {
    const row = await db.event_check_ins.findFirstOrThrow({ where: { event_id: w.eventId, user_id: w.inside[5], status: "checked_in" }, select: { id: true } })
    await performCheckout(row.id, "manual")
    expect(await everyCount()).toMatchObject({ helper: 6, rowHere: 6, rowMembers: 6, preview: 6, detailChat: 6, listed: 5 })
    // The member row is still there, still active: the count never read it.
    expect(await db.chat_group_members.count({ where: { chat_group_id: w.roomId, status: "active" } })).toBe(9)
  })

  it("an expiry takes one off too", async () => {
    const row = await db.event_check_ins.findFirstOrThrow({ where: { event_id: w.eventId, user_id: w.inside[4], status: "checked_in" }, select: { id: true } })
    await db.event_check_ins.update({ where: { id: row.id }, data: { expires_at: new Date(Date.now() - 1000) } })
    await performCheckout(row.id, "expired")
    expect(await everyCount()).toMatchObject({ helper: 5, rowHere: 5, preview: 5, detailChat: 5, listed: 4 })
  })

  it("a host is listed in the room whether or not they are checked in", async () => {
    const host = await person("rc_mod")
    await db.chat_group_members.create({ data: { chat_group_id: w.roomId, user_id: host, anonymous_name: testId("Heron"), role: "moderator" } })
    const counts = await everyCount()
    expect(counts.listed).toBe(5)
    // ...and is not in the headcount, which is attendees inside.
    expect(counts.helper).toBe(5)
  })
})
