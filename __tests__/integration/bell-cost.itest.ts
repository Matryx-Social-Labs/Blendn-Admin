/**
 * What one poll of the bell costs (SCRUM-740). Every mobile screen asks
 * `GET /notifications`, and since the Flow 9 fields it also decorates each row
 * and counts unread conversations. The cost must not grow with the page: a
 * fixed number of statements however many rows, one set-based read per kind,
 * and the unread-conversation count answered by the partial index.
 *
 * The statements are counted where they leave for Postgres (`pg`'s client), so
 * a Prisma relation load or a hidden loop shows up here and a rename does not.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { randomUUID } from "crypto"
import { Client } from "pg"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, testId } from "./helpers"
import { conversationPair } from "@/lib/conversations"
import { req } from "./go-live-world"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const feed = require("@/app/api/mobile/notifications/route") as typeof import("@/app/api/mobile/notifications/route")

const users: string[] = []
const events: string[] = []
const crews: string[] = []
const conversations: string[] = []
const blends: { blend: string; room: string }[] = []
const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

/** Every statement sent to Postgres while `run` runs: its text and parameters. */
async function statementsDuring<T>(run: () => Promise<T>): Promise<{ result: T; statements: { text: string; values: unknown[] }[]; ms: number }> {
  const statements: { text: string; values: unknown[] }[] = []
  const original = Client.prototype.query
  // The overloads of `query` are not worth restating: record what was asked, pass everything on.
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; values?: unknown[] }
    statements.push(typeof first === "string" ? { text: first, values: (args[1] as unknown[]) ?? [] } : { text: first.text ?? "", values: first.values ?? [] })
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof Client.prototype.query
  const started = performance.now()
  try {
    const result = await run()
    return { result, statements, ms: performance.now() - started }
  } finally {
    Client.prototype.query = original
  }
}

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.upsert({ where: { id }, create: { id, name: `Person ${label}`, onboarded: true }, update: {} })
  return id
}

const poll = (viewer: string, limit: number) =>
  feed.GET(req(`/api/mobile/notifications?limit=${limit}`, tokenOf(viewer)))

/** `count` rows spread over every kind the bell decorates, each pointing at something real or at nothing. */
async function fillBell(viewer: string, count: number) {
  const host = await person(`bc-host-${count}`)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const crew = await db.crews.create({ data: { name: "Bell crew", created_by: host, emblem_seed: "seed-bell" } as never })
  crews.push(crew.id)
  /*
   * Real things behind the rows, so every decoration read runs as it does in production (review M1): an invite the
   * Crews screen would list (the host a member and the viewer's friend), and a live Blend the viewer is in, its door
   * read with both crews' members and the viewer's check-in.
   */
  await db.crew_members.create({ data: { crew_id: crew.id, user_id: host, role: "owner", consented_reveal_at: new Date() } })
  const [f1, f2] = conversationPair(host, viewer)
  await db.friendships.create({ data: { user1_id: f1, user2_id: f2 } })
  await db.crew_invites.create({ data: { crew_id: crew.id, invited_user_id: viewer, invited_by: host } })
  const occurrenceId = await occurrenceOf(eventId)
  const other = await person(`bc-other-${count}`)
  const [idA, idB] = [randomUUID(), randomUUID()].sort()
  for (const [id, member] of [[idA, viewer], [idB, other]] as const) {
    await db.crews.create({ data: { id, name: id === idA ? "Night Owls" : "Early Birds", created_by: member, emblem_seed: `seed-${id}` } })
    crews.push(id)
    await db.crew_members.create({ data: { crew_id: id, user_id: member, consented_reveal_at: new Date() } })
    await db.event_check_ins.create({ data: { event_id: eventId, occurrence_id: occurrenceId, user_id: member, kind: "attendee", status: "checked_in", check_in_time: new Date() } })
  }
  const blend = await db.blends.create({ data: { occurrence_id: occurrenceId, a_crew_id: idA, b_crew_id: idB, closes_at: new Date(Date.now() + 12 * 3_600_000) } })
  const room = await db.chat_groups.create({
    data: { kind: "blend", blend_id: blend.id, name: "Night Owls × Early Birds", members: { createMany: { data: [{ user_id: viewer }, { user_id: other }] } } },
  })
  blends.push({ blend: blend.id, room: room.id })

  const kinds = ["friend_request", "crew_invite", "crew_here", "blend", "message_request", "board_request", "match", "event_update", "event_changed", "announcement"] as const
  const rows = []
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length]
    const data: Record<string, string> = { type: kind }
    if (kind === "friend_request") {
      const asker = await person(`bc-asker-${count}-${i}`)
      data.requestId = (await db.friend_requests.create({ data: { sender_id: asker, recipient_id: viewer } })).id
    } else if (kind === "crew_invite" || kind === "crew_here") data.crewId = crew.id
    else if (kind === "blend") data.blendId = blend.id
    else if (kind === "message_request" || kind === "board_request") data.requestId = randomUUID()
    else if (kind === "match") data.conversationId = randomUUID()
    else data.eventId = eventId
    rows.push({ user_id: viewer, kind, title: "t", body: "b", data, created_at: new Date(Date.now() - i * 1000) })
  }
  await db.notifications.createMany({ data: rows })
}

afterAll(async () => {
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
  await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: blends.map((b) => b.room) } } })
  await db.chat_groups.deleteMany({ where: { id: { in: blends.map((b) => b.room) } } })
  await db.blends.deleteMany({ where: { id: { in: blends.map((b) => b.blend) } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.crew_invites.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crews } } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
}, 120_000)

/**
 * The most statements one poll can send, measured with a REAL live Blend and a real open invite behind the rows
 * (review M1), so every decoration read runs: the page and its two counts (3); the decoration reads, one per kind
 * (friend requests, memberships, message and board requests, conversations, events, crews: 7) and the friend
 * request's sender and profile (2); everybody kept apart from the reader, read once for every door (2); the crew
 * invite door (the invites, their crews' members, the friends: 4, plus a crew Prisma loads for the relation); and
 * the Blend door (the Blends, their rooms, crews, members and the reader's check-ins: 5). Each once per page, never
 * per row: the 10-row and 50-row pages below cost the same, and no statement is sent twice.
 */
const MOST_STATEMENTS = 23

it("a 50-row page costs the statements a 10-row page does, once each, and no more than the cap", async () => {
  const small = await person("bc-small")
  const big = await person("bc-big")
  await fillBell(small, 10)
  await fillBell(big, 50)
  await poll(big, 50) // warm: the first call of a process pays for the pool and the schema

  const ofTen = await statementsDuring(() => poll(small, 10))
  const ofFifty = await statementsDuring(() => poll(big, 50))

  const fifty = (await ofFifty.result.json()).data.notifications as { kind: string; open?: boolean; display?: { context?: string } }[]
  expect(fifty).toHaveLength(50)
  // The real things decorate: the Blend is named through its door, the invite is open and named.
  expect(fifty.find((n) => n.kind === "blend")?.display?.context).toBe("Night Owls × Early Birds")
  expect(fifty.find((n) => n.kind === "crew_invite")).toMatchObject({ open: true, display: { context: "Bell crew" } })
  expect(ofTen.statements).toHaveLength(ofFifty.statements.length)
  expect(ofFifty.statements.length).toBeLessThanOrEqual(MOST_STATEMENTS)
  // One read per table, however many rows ask: a statement sent twice is a loop.
  const texts = ofFifty.statements.map((statement) => statement.text)
  expect(new Set(texts).size).toBe(texts.length)
})

it("the unread-conversation count is answered by the partial index, not by reading the DM table", async () => {
  const me = await person("bc-idx-me")
  const bystanders = [await person("bc-idx-a"), await person("bc-idx-b")].sort()
  const noise = await db.private_conversations.create({ data: { user1_id: bystanders[0], user2_id: bystanders[1] } })
  conversations.push(noise.id)
  // Read messages are nearly all of the table in production: a table of them, and a handful that are not.
  await db.$executeRaw`
    INSERT INTO private_messages (id, conversation_id, sender_id, message_text, is_read)
    SELECT gen_random_uuid(), ${noise.id}::uuid, ${bystanders[0]}, 'x', true FROM generate_series(1, 60000)`
  for (let i = 0; i < 5; i++) {
    const other = await person(`bc-idx-o${i}`)
    const [user1_id, user2_id] = [me, other].sort()
    const thread = await db.private_conversations.create({ data: { user1_id, user2_id } })
    conversations.push(thread.id)
    await db.private_messages.create({ data: { conversation_id: thread.id, sender_id: other, message_text: "unread", is_read: false } })
  }
  await db.$executeRaw`ANALYZE private_messages`

  const run = await statementsDuring(() => poll(me, 20))
  expect((await run.result.json()).data.badgeCount).toBe(5)
  const count = run.statements.find((statement) => statement.text.includes('FROM "public"."private_conversations"') && statement.text.includes("COUNT"))!
  const plan = await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${count.text}`, ...count.values)
  const text = plan.map((line) => line["QUERY PLAN"]).join("\n")
  expect(text).toContain("Index Scan using private_messages_unread_idx")
  expect(text).not.toMatch(/Seq Scan on private_messages/)
}, 120_000)
