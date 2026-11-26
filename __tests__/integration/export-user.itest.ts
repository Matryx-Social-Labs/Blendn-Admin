/*
 * scripts/export-user.ts answers a person's request for a copy of their data
 * (SCRUM-1249). Real rows, real queries: A and B share an event, a room, a DM
 * thread and a friendship; C was in the same room and talks to B, and is
 * nothing to A. The export of A carries A's own rows and words; B appears only
 * as an opaque reference and a pseudonym; C does not appear at all.
 */
import { EXPORT_CHECKLIST, exportUser } from "@/scripts/export-user"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf } from "./helpers"

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.event_waves.deleteMany({ where: { event_id: { in: events } } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

type Exported = Awaited<ReturnType<typeof exportUser>> & Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let a: string, b: string, c: string
let out: Exported
let text: string

beforeAll(async () => {
  const host = await makeUser("exp-host", "organizer")
  a = await makeUser("exp-a")
  b = await makeUser("exp-b")
  c = await makeUser("exp-c")
  users.push(host, a, b, c)
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

  out = (await exportUser(db, a)) as Exported
  text = JSON.stringify(out)
})

it("has A's account, A's check-in as stored, and A's own words", () => {
  expect(out.account).toMatchObject({ id: a, email: `${a}@itest.invalid` })
  expect(out.profile).toMatchObject({ name: "Asha Rao", phone: "+919800000001" })
  expect(out.check_ins).toHaveLength(1)
  expect(out.check_ins[0]).toMatchObject({ latitude: 12.97, longitude: 77.59 })
  expect(out.room_messages.map((m: { content: string }) => m.content)).toEqual(["hello from A in the room"])
  expect(out.dm_messages.map((m: { text: string }) => m.text)).toEqual(["A to B in the DM"])
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
  expect(out.waves).toEqual([expect.objectContaining({ direction: "sent", person: friend.person })])
})

it("withholds every word somebody else wrote: the DM reply, the room, the report excerpt", () => {
  // The pick (Fable advisor, 2026-11-26): another person's words are their personal data too.
  expect(text).not.toContain("B private reply")
  expect(text).not.toContain("B says hi")
  expect(out.room_memberships).toEqual([expect.objectContaining({ my_pseudonym: "Quiet Otter", messages_by_others: 2 })])
})

it("has no row of C, who shares nothing with A but a room", () => {
  for (const leak of [c, `${c}@itest.invalid`, "Chitra Iyer", "+919800000003", "Calm Heron", "C room words", "C to B"]) {
    expect(text).not.toContain(leak)
  }
})

it("puts every table it says it exports into the document", () => {
  const exported = Object.values(EXPORT_CHECKLIST).filter((v) => !v.startsWith("not exported"))
  expect(exported.length).toBeGreaterThan(0)
  for (const key of exported) expect(out).toHaveProperty(key)
})
