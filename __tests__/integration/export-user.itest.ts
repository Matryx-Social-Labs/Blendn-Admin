/*
 * scripts/export-user.ts answers a person's request for a copy of their data
 * (SCRUM-1249). Real rows, real queries: A and B share an event, a room, a DM
 * thread and a friendship; C was in the same room and talks to B, and is
 * nothing to A. The export of A carries A's own rows and words; B appears only
 * as an opaque reference and a pseudonym; C does not appear at all.
 */
import { EXPORT_CHECKLIST, exportUser, readOnly, type UserExport } from "@/scripts/export-user"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  const anyOf = { in: users }
  await db.event_waves.deleteMany({ where: { event_id: { in: events } } })
  await db.event_likes.deleteMany({ where: { event_id: { in: events } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.message_requests.deleteMany({ where: { sender_id: anyOf } })
  await db.friend_requests.deleteMany({ where: { sender_id: anyOf } })
  await db.notifications.deleteMany({ where: { user_id: anyOf } })
  await db.blocked_users.deleteMany({ where: { blocker_id: anyOf } })
  await db.user_reports.deleteMany({ where: { reporter_id: anyOf } })
  await db.referrals.deleteMany({ where: { invitee_id: anyOf } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

let a: string, b: string, c: string, d: string
let out: UserExport
let text: string

beforeAll(async () => {
  const host = await makeUser("exp-host", "organizer")
  a = await makeUser("exp-a")
  b = await makeUser("exp-b")
  c = await makeUser("exp-c")
  d = await makeUser("exp-d")
  users.push(host, a, b, c, d)
  await db.profiles.createMany({
    data: [
      { id: a, name: "Asha Rao", phone: "+919800000001", onboarded: true },
      { id: b, name: "Bilal Khan", phone: "+919800000002", onboarded: true },
      { id: c, name: "Chitra Iyer", phone: "+919800000003", onboarded: true },
    ],
  })
  const eventId = await makeEvent(host)
  events.push(eventId)
  const occurrence_id = await occurrenceOf(eventId)
  await db.event_check_ins.createMany({
    data: [a, b, c].map((user_id, i) => ({
      event_id: eventId,
      occurrence_id,
      user_id,
      status: "checked_in" as const,
      check_in_time: new Date(),
      latitude: 12.97 + i / 100,
      longitude: 77.59 + i / 100,
    })),
  })

  const room = await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
  await db.chat_group_members.createMany({
    data: [
      { chat_group_id: room.id, user_id: a, anonymous_name: "Quiet Otter" },
      { chat_group_id: room.id, user_id: b, anonymous_name: "Bold Fox" },
      { chat_group_id: room.id, user_id: c, anonymous_name: "Calm Heron" },
    ],
  })
  await db.chat_messages.createMany({
    data: [
      { chat_group_id: room.id, user_id: a, content: "hello from A in the room" },
      { chat_group_id: room.id, user_id: b, content: "B says hi in the room" },
      { chat_group_id: room.id, user_id: c, content: "C room words" },
    ],
  })

  const [u1, u2] = [a, b].sort()
  const thread = await db.private_conversations.create({
    data: {
      user1_id: u1,
      user2_id: u2,
      user1_pseudonym: u1 === a ? "Quiet Otter" : "Bold Fox",
      user2_pseudonym: u2 === a ? "Quiet Otter" : "Bold Fox",
    },
  })
  await db.private_messages.createMany({
    data: [
      { conversation_id: thread.id, sender_id: a, message_text: "A to B in the DM" },
      { conversation_id: thread.id, sender_id: b, message_text: "B private reply, call me on 98000 00002" },
    ],
  })
  const [c1, c2] = [b, c].sort()
  const other = await db.private_conversations.create({ data: { user1_id: c1, user2_id: c2 } })
  await db.private_messages.create({ data: { conversation_id: other.id, sender_id: c, message_text: "C to B, not A's" } })

  await db.friendships.create({ data: { user1_id: u1, user2_id: u2 } })
  await db.event_waves.createMany({
    data: [
      { event_id: eventId, from_id: a, to_id: b },
      { event_id: eventId, from_id: c, to_id: b },
    ],
  })
  // A reported B's message: the report is A's, the excerpt is B's words.
  await db.message_reports.create({
    data: { reporter_id: a, message_id: thread.id, message_type: "private", reason: "spam", excerpt: "B private reply, call me on 98000 00002" },
  })

  // The received side, where other people's words and choices sit.
  await db.message_requests.create({ data: { sender_id: b, recipient_id: a, message: "SECRET-MR from B" } })
  await db.notifications.create({ data: { user_id: a, kind: "private_message", title: "Bilal Khan", body: "SECRET-N preview" } })
  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: a, kind: "chat", body: "A's own post" } })
  await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: b, to_user_id: a, message: "SECRET-BR from B" } })
  await db.event_waves.create({ data: { event_id: eventId, from_id: b, to_id: a } })
  await db.blocked_users.create({ data: { blocker_id: a, blocked_id: d, seen_as: "Dim Lark" } })
  await db.user_reports.create({ data: { reporter_id: a, reported_id: d, reason: "spam", description: "A's own words" } })
  // D: a second person, so one ref per person is tested, not one ref for everyone.
  await db.event_likes.create({ data: { event_id: eventId, liker_id: a, liked_id: d } })
  await db.event_likes.create({ data: { event_id: eventId, liker_id: c, liked_id: a } })
  await db.referrals.create({ data: { invitee_id: a, inviter_id: d } })
  // Held for a match, so never shown to A: not A's to read.
  await db.friend_requests.create({ data: { sender_id: c, recipient_id: a, held_at: new Date() } })

  out = await exportUser(db, a)
  text = JSON.stringify(out)
})

it("has A's account, A's check-in as stored, and A's own words", () => {
  expect(out.account).toMatchObject({ id: a, email: `${a}@itest.invalid` })
  expect(out.profile).toMatchObject({ name: "Asha Rao", phone: "+919800000001" })
  expect(out.check_ins).toHaveLength(1)
  expect(out.check_ins[0]).toMatchObject({ latitude: 12.97, longitude: 77.59 })
  expect(out.room_messages.map((m) => m.content)).toEqual(["hello from A in the room"])
  expect(out.dm_messages.map((m) => m.text)).toEqual(["A to B in the DM"])
  expect(out.board_posts.map((p) => p.body)).toEqual(["A's own post"])
  expect(out.user_reports_filed).toEqual([expect.objectContaining({ description: "A's own words" })])
  expect(out.message_reports_filed).toHaveLength(1)
})

it("shows B only as one opaque reference and a pseudonym, never an email, phone, name or id", () => {
  for (const leak of [b, `${b}@itest.invalid`, "Bilal Khan", "+919800000002", "Test exp-b"]) {
    expect(text).not.toContain(leak)
  }
  const [friend] = out.friends
  const [thread] = out.dm_threads
  expect(out.friends).toHaveLength(1)
  expect(thread).toMatchObject({ counterpart: friend.person, counterpart_pseudonym: "Bold Fox", my_pseudonym: "Quiet Otter", messages_by_counterpart: 1 })
  expect(out.waves).toEqual([
    expect.objectContaining({ direction: "sent", person: friend.person }),
    expect.objectContaining({ direction: "received", person: friend.person }),
  ])
  expect(out.message_requests).toEqual([expect.objectContaining({ direction: "received", person: friend.person })])
  expect(out.board_requests).toEqual([expect.objectContaining({ direction: "received", person: friend.person })])
})

it("gives each other person one reference of their own, the same everywhere", () => {
  const b = out.friends[0].person
  const dRef = out.blocks[0].person
  expect(dRef).not.toBe(b)
  expect(out.blocks[0].seen_as).toBe("Dim Lark")
  expect(out.user_reports_filed[0].person).toBe(dRef)
  expect(out.likes_sent).toEqual([expect.objectContaining({ person: dRef })])
  expect(out.referral.invited_by).toBe(dRef)
  expect(text).not.toContain(d)
  expect(JSON.stringify(out).match(/person-\d+/g)?.every((r) => r === b || r === dRef)).toBe(true)
})

it("withholds every word somebody else wrote: the DM reply, the room, the report excerpt", () => {
  // The pick (Fable advisor, 2026-11-26): another person's words are their personal data too.
  for (const words of ["B private reply", "B says hi", "SECRET-", "Bilal"]) expect(text).not.toContain(words)
  expect(out.notifications).toEqual([expect.objectContaining({ kind: "private_message" })])
  expect(out.room_memberships).toEqual([expect.objectContaining({ my_pseudonym: "Quiet Otter", messages_by_others: 2 })])
})

it("has no row of C, who shares only a room with A, likes A in secret and asked to be friends on hold", () => {
  expect(out.friend_requests).toEqual([])
  for (const leak of [c, `${c}@itest.invalid`, "Chitra Iyer", "+919800000003", "Calm Heron", "C room words", "C to B"]) {
    expect(text).not.toContain(leak)
  }
})

it("runs in a transaction the database refuses to write in", async () => {
  await expect(readOnly(db, (tx) => tx.user.update({ where: { id: a }, data: { name: "written" } }))).rejects.toThrow(/read-only transaction/)
  expect((await db.user.findUniqueOrThrow({ where: { id: a } })).name).toBe("Test exp-a")
})

it("puts every table it says it exports into the document", () => {
  const exported = Object.values(EXPORT_CHECKLIST).filter((v) => !v.startsWith("not exported"))
  expect(exported.length).toBeGreaterThan(0)
  for (const key of exported) expect(out).toHaveProperty(key)
})
