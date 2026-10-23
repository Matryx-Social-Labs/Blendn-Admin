import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { PRE_EVENT_CHAT_HOURS } from "@/lib/chat-window"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * A room that has not opened yet tells the people entitled to it when it will,
 * and tells everybody else exactly what it always did.
 *
 * Real Postgres because the claim is about rows NOT written: asking early must
 * leave no membership behind, and only a query can say so.
 */

const HOUR = 60 * 60 * 1000
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) await db.event_favorites.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

type Person = { id: string; token: string }

async function person(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function eventStartingIn(hours: number): Promise<{ eventId: string; start: Date }> {
  const host = await makeUser(testId("opens-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const start = new Date(Date.now() + hours * HOUR)
  await db.events.update({
    where: { id: eventId },
    data: { start_time: start, end_time: new Date(start.getTime() + 2 * HOUR) },
  })
  return { eventId, start }
}

async function ask(method: "GET" | "POST", eventId: string, as: Person) {
  const handler = eventChat[method] as unknown as (
    req: NextRequest,
    ctx: { params: Promise<{ eventId: string }> }
  ) => Promise<Response>
  const res = await handler(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/chat`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${as.token}` },
      ...(method === "POST" && { body: JSON.stringify({ content: "hello early" }) }),
    }),
    { params: Promise.resolve({ eventId }) }
  )
  return { status: res.status, json: await res.json() }
}

const memberRows = (eventId: string) =>
  db.chat_group_members.count({ where: { chat_group: { event_id: eventId } } })

describe("the room before its window", () => {
  let eventId: string
  let opensAt: string
  let rsvp: Person
  let saver: Person
  let outsider: Person

  beforeAll(async () => {
    const e = await eventStartingIn(3 * 24)
    eventId = e.eventId
    opensAt = new Date(e.start.getTime() - PRE_EVENT_CHAT_HOURS * HOUR).toISOString()
    rsvp = await person("opens-rsvp")
    saver = await person("opens-saver")
    outsider = await person("opens-outsider")
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: rsvp.id, status: "going" } })
    await db.event_favorites.create({ data: { event_id: eventId, user_id: saver.id } })
  })

  it("tells somebody who RSVP'd when it opens, and writes no membership", async () => {
    const res = await ask("GET", eventId, rsvp)

    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({
      success: false,
      errorCode: "CHAT_CLOSED",
      reasonCode: "NOT_OPEN_YET",
      opensAt,
    })
    expect(await memberRows(eventId)).toBe(0)
  })

  it("tells somebody who saved it the same", async () => {
    const res = await ask("GET", eventId, saver)

    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({ errorCode: "CHAT_CLOSED", reasonCode: "NOT_OPEN_YET", opensAt })
    expect(await memberRows(eventId)).toBe(0)
  })

  it("names the room once a row exists, and still writes no membership", async () => {
    const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })

    const res = await ask("GET", eventId, rsvp)

    expect(res.status).toBe(403)
    expect(res.json.chatGroupId).toBe(room.id)
    expect(res.json.reasonCode).toBe("NOT_OPEN_YET")
    expect(await memberRows(eventId)).toBe(0)
  })

  it("answers a send the same way, and a send does not join", async () => {
    const res = await ask("POST", eventId, rsvp)

    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({ errorCode: "CHAT_CLOSED", reasonCode: "NOT_OPEN_YET", opensAt })
    expect(await memberRows(eventId)).toBe(0)
  })

  it("gives somebody not entitled nothing: no opensAt, today's refusals", async () => {
    const read = await ask("GET", eventId, outsider)
    const send = await ask("POST", eventId, outsider)

    // The read says join; the send's window gate has always said when.
    expect(read.status).toBe(403)
    expect(read.json).toEqual({ success: false, error: "RSVP to this event to join the chat", errorCode: "FORBIDDEN" })
    expect(send.status).toBe(403)
    expect(send.json).toEqual({
      success: false,
      error: "This chat opens 24 hours before the event starts.",
      errorCode: "FORBIDDEN",
    })
    expect(await memberRows(eventId)).toBe(0)
  })
})

describe("the room inside its window", () => {
  it("opens as it always did for somebody who RSVP'd", async () => {
    const { eventId } = await eventStartingIn(2)
    const guest = await person("opens-inside")
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: guest.id, status: "going" } })

    const res = await ask("GET", eventId, guest)

    expect(res.status).toBe(200)
    expect(res.json.data.write.allowed).toBe(true)
    expect(res.json.opensAt).toBeUndefined()
    expect(await memberRows(eventId)).toBe(1)
  })
})
