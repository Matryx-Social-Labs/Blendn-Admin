process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { checkAndAutoMute, checkAndAutoUnmute } from "@/lib/moderation/actions"
import { checkContactInfo } from "@/lib/moderation/contact-info"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * Three hidden messages in an hour mute somebody, and a contact detail is not
 * one of them (SCRUM-485). `preSaveCheck` says a contact hide never starts a
 * mute, but the count that decides the NEXT mute counted every hidden flag, so
 * three shared numbers then one abusive message muted the person on their first
 * abusive message. A mute counts abuse only; the auto-unmute counts the same.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_messages.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_group_members.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
}, 60_000)

async function room() {
  const host = await makeUser(testId("am_host"), "organizer")
  const sender = await makeUser(testId("am_sender"))
  users.push(host, sender)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: sender, anonymous_name: testId("Otter"), status: "active" } })
  return { groupId: group.id, userId: sender }
}

async function flag(r: { groupId: string; userId: string }, categories: Record<string, number>, createdAt?: Date, groupId = r.groupId, userId = r.userId) {
  const message = await db.chat_messages.create({
    data: { chat_group_id: groupId, user_id: userId, content: "x", moderation_status: "hidden" },
  })
  await db.moderation_flags.create({
    data: { message_id: message.id, chat_group_id: groupId, user_id: userId, source: "auto_keyword", categories, confidence: 1, auto_action: "hidden", ...(createdAt && { created_at: createdAt }) },
  })
}

const statusOf = async (r: { groupId: string; userId: string }) =>
  (await db.chat_group_members.findUniqueOrThrow({ where: { chat_group_id_user_id: { chat_group_id: r.groupId, user_id: r.userId } } })).status

describe("the auto-mute count", () => {
  it("does not mute for one abusive message after three contact-detail hides", async () => {
    const r = await room()
    // The categories the pipeline really writes for a number, not a hand-typed key.
    const contact = checkContactInfo("call me on 98765 43210")!.categories as Record<string, number>
    for (let i = 0; i < 3; i++) await flag(r, contact)
    await flag(r, { profanity: 1 })
    await checkAndAutoMute(r.userId, r.groupId)
    expect(await statusOf(r)).toBe("active")
  })

  it("counts empty and openai-shaped categories as abuse, and keeps rooms, people and the window apart", async () => {
    const r = await room()
    const other = await room()
    const old = new Date(Date.now() - 2 * 3_600_000)
    await flag(r, {})
    await flag(r, { "sexual/minors": 0.9 })
    // None of these are this person's abuse in this room within the hour.
    await flag(r, { profanity: 1 }, old)
    await flag(other, { profanity: 1 })
    await flag(r, { profanity: 1 }, undefined, r.groupId, other.userId)
    await checkAndAutoMute(r.userId, r.groupId)
    expect(await statusOf(r)).toBe("active")
    await flag(r, { hate: 0.8 })
    await checkAndAutoMute(r.userId, r.groupId)
    expect(await statusOf(r)).toBe("muted")
  })

  it("mutes at three abusive hides, whatever contact hides sit beside them", async () => {
    const r = await room()
    await flag(r, { contact_phone: 1 })
    for (let i = 0; i < 3; i++) await flag(r, { profanity: 1 })
    await checkAndAutoMute(r.userId, r.groupId)
    expect(await statusOf(r)).toBe("muted")
  })

  it("counts a hide that carries both a contact detail and abuse", async () => {
    const r = await room()
    for (let i = 0; i < 3; i++) await flag(r, { contact_phone: 1, profanity: 1 })
    await checkAndAutoMute(r.userId, r.groupId)
    expect(await statusOf(r)).toBe("muted")
  })

  it("lifts an automatic mute that only contact hides were holding up", async () => {
    const r = await room()
    await db.chat_group_members.updateMany({ where: { chat_group_id: r.groupId, user_id: r.userId }, data: { status: "muted", muted_at: new Date(), muted_by: null } })
    for (const kind of ["phone", "handle", "link"]) await flag(r, { [`contact_${kind}`]: 1 })
    expect(await checkAndAutoUnmute(r.userId, r.groupId)).toBe(true)
    expect(await statusOf(r)).toBe("active")
  })
})
