/*
 * Backend round 4 (queue task 10): the small server fixes found in the
 * redesign drives, each with its control.
 *
 * - DELETE /rsvp (and not_going) is refused while the caller is checked in.
 * - The waitlist pushes no "A place opened up" once the event has started, and
 *   promotes nobody after its end.
 * - `roomIsOpen` (GET /waves) reads the run's real end: a cancelled last day
 *   does not hold the room open.
 * - `syncOccurrences` cancels, rather than deletes, a day a crew like or a
 *   Blend points at (the seed's `--refresh-times` died on that FK).
 * - A block from a message request sent from a Lobby room keeps the room's name.
 */
import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/push-notifications", () => ({ sendPushNotification: jest.fn(async () => true) }))

import { sendPushNotification } from "@/lib/push-notifications"
import { signAccessToken } from "@/lib/mobile-auth"
import { syncOccurrences } from "@/lib/occurrences"
import { promoteFromWaitlist } from "@/lib/waitlist"
import { roomIsOpen } from "@/lib/waves"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
const respondRoute = require("@/app/api/mobile/message-requests/[requestId]/respond/route") as typeof import("@/app/api/mobile/message-requests/[requestId]/respond/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const users: string[] = []
const events: string[] = []
const crews: string[] = []

afterAll(async () => {
  await db.crew_likes.deleteMany({ where: { liked_by_user_id: { in: users } } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(label)
  await onboard(id)
  users.push(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function event() {
  const host = await makeUser("sf-host", "organizer")
  users.push(host)
  const id = await makeEvent(host)
  events.push(id)
  return id
}

const rsvp = (eventId: string, token: string, method: "DELETE" | "POST", body?: unknown) =>
  rsvpRoute[method](
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/rsvp`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ eventId }) }
  )

describe("RSVP withdrawal while checked in", () => {
  it("refuses DELETE and not_going with 409 ALREADY_CHECKED_IN, and keeps the RSVP", async () => {
    const eventId = await event()
    const me = await person("sf-in")
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: me.id, status: "going" } })
    await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: me.id })

    for (const [method, body] of [["DELETE", undefined], ["POST", { status: "not_going" }]] as const) {
      const res = await rsvp(eventId, me.token, method, body)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ success: false, reasonCode: "ALREADY_CHECKED_IN", error: expect.stringMatching(/check out/i) })
    }
    expect((await db.event_rsvps.findFirstOrThrow({ where: { event_id: eventId, user_id: me.id } })).status).toBe("going")
  })

  it("control: after checking out, DELETE withdraws", async () => {
    const eventId = await event()
    const me = await person("sf-out")
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: me.id, status: "going" } })
    await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: me.id })
    await db.event_check_ins.updateMany({ where: { event_id: eventId, user_id: me.id }, data: { status: "checked_out", check_out_time: new Date() } })

    expect((await rsvp(eventId, me.token, "DELETE")).status).toBe(200)
    expect(await db.event_rsvps.count({ where: { event_id: eventId, user_id: me.id } })).toBe(0)
  })
})

describe("the waitlist once the event has started or ended", () => {
  async function full(start: Date, end: Date) {
    const eventId = await event()
    const [going, waiting] = [await person("sf-wl-going"), await person("sf-wl-wait")]
    await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: end, max_capacity: 1 } })
    await db.event_rsvps.createMany({ data: [{ event_id: eventId, user_id: waiting.id, status: "waitlisted" }] })
    ;(sendPushNotification as jest.Mock).mockClear()
    return { eventId, waiting: waiting.id, going: going.id }
  }
  const statusOf = async (eventId: string, userId: string) =>
    (await db.event_rsvps.findFirstOrThrow({ where: { event_id: eventId, user_id: userId } })).status

  it("after the start: promotes, but pushes no \"A place opened up\" (the door already takes them)", async () => {
    const { eventId, waiting } = await full(new Date(Date.now() - HOUR), new Date(Date.now() + HOUR))
    expect(await promoteFromWaitlist(eventId)).toEqual([waiting])
    expect(await statusOf(eventId, waiting)).toBe("going")
    expect(sendPushNotification).not.toHaveBeenCalled()
  })

  it("after the end: promotes nobody", async () => {
    const { eventId, waiting } = await full(new Date(Date.now() - 3 * HOUR), new Date(Date.now() - HOUR))
    expect(await promoteFromWaitlist(eventId)).toEqual([])
    expect(await statusOf(eventId, waiting)).toBe("waitlisted")
  })

  it("control: before the start, promotes and pushes", async () => {
    const { eventId, waiting } = await full(new Date(Date.now() + DAY), new Date(Date.now() + DAY + 3 * HOUR))
    expect(await promoteFromWaitlist(eventId)).toEqual([waiting])
    expect(sendPushNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: waiting, data: expect.objectContaining({ type: "waitlist_promoted" }) }))
  })
})

describe("roomIsOpen reads the run's real end", () => {
  /** A two-day run: day 1 ended two days ago, day 2 (today) is called off or not. The run's own end_time is still ahead. */
  async function run(cancelLastDay: boolean) {
    const eventId = await event()
    const now = Date.now()
    await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(now - 3 * DAY), end_time: new Date(now + HOUR) } })
    await db.event_occurrences.createMany({
      data: [
        { event_id: eventId, occurs_on: new Date(new Date(now - 3 * DAY).toISOString().slice(0, 10)), start_time: new Date(now - 3 * DAY), end_time: new Date(now - 2 * DAY) },
        {
          event_id: eventId,
          occurs_on: new Date(new Date(now - HOUR).toISOString().slice(0, 10)),
          start_time: new Date(now - HOUR),
          end_time: new Date(now + HOUR),
          cancelled_at: cancelLastDay ? new Date(now - 6 * HOUR) : null,
        },
      ],
    })
    return eventId
  }

  it("is closed when the last held day ended more than the window ago", async () => {
    expect(await roomIsOpen(await run(true))).toBe(false)
  })

  it("control: open while the last day is held", async () => {
    expect(await roomIsOpen(await run(false))).toBe(true)
  })

  it("closed when every day is called off", async () => {
    const eventId = await event()
    await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { cancelled_at: new Date() } })
    expect(await roomIsOpen(eventId)).toBe(false)
  })
})

describe("syncOccurrences and a day a crew points at", () => {
  it("cancels, rather than deletes, a dropped day with a crew like on it; a day nobody touched is deleted", async () => {
    const eventId = await event()
    const now = new Date()
    const liker = await person("sf-crew")
    const crew = await db.crews.create({ data: { name: "Sync Owls", emblem_seed: "sf", created_by: liker.id }, select: { id: true } })
    crews.push(crew.id)
    const other = await person("sf-crew-to")
    // Two days, both later dropped: one liked, one not.
    await db.event_occurrences.deleteMany({ where: { event_id: eventId } })
    const [liked, bare] = await Promise.all(
      [3, 4].map((d) =>
        db.event_occurrences.create({
          data: { event_id: eventId, occurs_on: new Date(new Date(now.getTime() - d * DAY).toISOString().slice(0, 10)), start_time: new Date(now.getTime() - d * DAY), end_time: new Date(now.getTime() - d * DAY + HOUR) },
          select: { id: true },
        })
      )
    )
    await db.crew_likes.create({ data: { occurrence_id: liked.id, from_crew_id: crew.id, to_user_id: other.id, liked_by_user_id: liker.id } })

    await syncOccurrences(eventId, new Date(now.getTime() - HOUR), new Date(now.getTime() + HOUR), "UTC")

    expect((await db.event_occurrences.findUniqueOrThrow({ where: { id: liked.id } })).cancelled_at).not.toBeNull()
    expect(await db.event_occurrences.count({ where: { id: bare.id } })).toBe(0)
  })
})

describe("a block from a Lobby-sourced message request", () => {
  async function requestFrom(roomName: string | null) {
    const eventId = await event()
    const [me, them] = [await person("sf-lr-me"), await person("sf-lr-them")]
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: them.id, kind: "offer", body: "Two seats", spaces_left: 2 }, select: { id: true } })
    const room = roomName
      ? await db.chat_groups.create({ data: { kind: "board_post", board_post_id: post.id, name: roomName }, select: { id: true } })
      : null
    const request = await db.message_requests.create({
      data: { sender_id: them.id, recipient_id: me.id, message: "hi", status: "pending", met_in_room_id: room?.id ?? null },
      select: { id: true },
    })
    const res = await respondRoute.POST(
      new NextRequest(`http://localhost/api/mobile/message-requests/${request.id}/respond`, {
        method: "POST",
        headers: { authorization: `Bearer ${me.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "block" }),
      }),
      { params: Promise.resolve({ requestId: request.id }) }
    )
    expect(res.status).toBe(200)
    return db.blocked_users.findFirstOrThrow({ where: { blocker_id: me.id, blocked_id: them.id } })
  }

  it("keeps the Lobby room's name as seen_in", async () => {
    expect(await requestFrom("Two seats from Indiranagar")).toMatchObject({ seen_as: null, seen_in: "Two seats from Indiranagar" })
  })

  it("control: a request from nowhere keeps nothing", async () => {
    expect(await requestFrom(null)).toMatchObject({ seen_as: null, seen_in: null })
  })
})
