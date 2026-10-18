jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { NextRequest } from "next/server"

import { KEYED_PSEUDONYMS_FROM, preferredPseudonymFor } from "@/lib/anonymous-names"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"
import { recordStatements, shape } from "./statements"

/* eslint-disable @typescript-eslint/no-require-imports */
const listRoute = require("@/app/api/mobile/board/requests/route") as typeof import("@/app/api/mobile/board/requests/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * GET /board/requests names every counterpart by the pseudonym of the EVENT the
 * ask belongs to: legacy-hashed for an event created before the keyed scheme,
 * keyed after, or the name the person already carries in that event's room.
 * Resolving the names cost two sequential statements per event (the room's
 * members, then the event's created_at just to pick the scheme); this pins the
 * names and that the cost no longer scales with the number of events.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function liveEvent(host: string, createdAt: Date) {
  const id = await makeEvent(host)
  events.push(id)
  const start = new Date(Date.now() + 24 * 3600_000)
  await db.events.update({
    where: { id },
    data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000), created_at: createdAt },
  })
  return id
}

async function ask(eventId: string, from: string, to: string) {
  const post = await db.board_posts.create({
    data: { event_id: eventId, author_id: to, kind: "offer", body: `Lift ${testId("p")}`, spaces_left: 3 },
    select: { id: true },
  })
  await db.board_requests.create({
    data: { event_id: eventId, post_id: post.id, from_user_id: from, to_user_id: to, status: "pending" },
  })
}

it("names each counterpart per event, and resolves them in one members read", async () => {
  const host = await makeUser(testId("brl-host"), "organizer")
  users.push(host)
  const me = await person("brl-me")
  const [a1, a2, b1, b2, c1] = await Promise.all(["a1", "a2", "b1", "b2", "c1"].map((l) => person(`brl-${l}`)))

  const legacyEvent = await liveEvent(host, new Date(KEYED_PSEUDONYMS_FROM.getTime() - 30 * 86_400_000))
  const keyedEvent = await liveEvent(host, new Date(KEYED_PSEUDONYMS_FROM.getTime() + 30 * 86_400_000))
  const thirdEvent = await liveEvent(host, new Date(KEYED_PSEUDONYMS_FROM.getTime() + 60 * 86_400_000))

  // Incoming asks at three events; one outgoing, at the legacy event.
  await ask(legacyEvent, a1.id, me.id)
  await ask(legacyEvent, a2.id, me.id)
  await ask(keyedEvent, b1.id, me.id)
  await ask(keyedEvent, b2.id, me.id)
  await ask(thirdEvent, c1.id, me.id)
  await ask(legacyEvent, me.id, c1.id)

  // b2 already carries a name in the keyed event's room: that wins over the derived one.
  const group = await db.chat_groups.create({ data: { event_id: keyedEvent, name: "room" } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: b2.id, anonymous_name: "Room Name Already" } })

  const { result: res, statements } = await recordStatements(() =>
    listRoute.GET(new NextRequest("http://localhost/api/mobile/board/requests", { headers: { authorization: `Bearer ${me.token}` } }))
  )
  expect(res.status).toBe(200)
  const body = (await res.json()).data as {
    incoming: { counterpart: string; event: { id: string } }[]
    outgoing: { counterpart: string; event: { id: string } }[]
  }
  console.log("requests:", shape(statements))

  const nameOf = (rows: typeof body.incoming, eventId: string) =>
    rows.filter((r) => r.event.id === eventId).map((r) => r.counterpart).sort()
  expect(nameOf(body.incoming, legacyEvent)).toEqual(
    [a1.id, a2.id].map((id) => preferredPseudonymFor(legacyEvent, id, "legacy")).sort()
  )
  expect(nameOf(body.incoming, keyedEvent)).toEqual(
    ["Room Name Already", preferredPseudonymFor(keyedEvent, b1.id, "keyed")].sort()
  )
  expect(nameOf(body.incoming, thirdEvent)).toEqual([preferredPseudonymFor(thirdEvent, c1.id, "keyed")])
  expect(nameOf(body.outgoing, legacyEvent)).toEqual([preferredPseudonymFor(legacyEvent, c1.id, "legacy")])

  // One read of the room members for the page, however many events it spans; and no
  // `SELECT id, created_at FROM events` per event just to pick a scheme.
  expect(statements.filter((s) => /\bchat_group_members\b/.test(s.sql)).length).toBe(1)
  expect(statements.filter((s) => /"events"\."id", "public"\."events"\."created_at" FROM "public"\."events"/.test(s.sql)).length).toBe(0)
})
