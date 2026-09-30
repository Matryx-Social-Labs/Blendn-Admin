/*
 * A sealed chat image's key names nobody, and erasure finds it through the
 * sender's own messages (SCRUM-448).
 *
 * The key was `chat/<senderId>/…`, and the signed URL shows its path to
 * everyone who sees the message: someone in two rooms with a person could
 * match that person's images across both. Without the id, `deletePrefix` can no
 * longer find a person's copies, so account deletion and the purge read them
 * off the messages, which outlive the account.
 */
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  deletePrefix: jest.fn().mockResolvedValue(0),
  deleteFile: jest.fn().mockResolvedValue(undefined),
}))

import { randomUUID } from "crypto"

import { eraseChatMedia, retainedChatMediaKeys, sentChatMediaKeys } from "@/lib/retained-media"
import { deleteFile, deletePrefix } from "@/lib/tigris"
import { db, closeDb, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
const conversations: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (conversations.length) {
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (events.length) {
    const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
    await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groups.map((g) => g.id) } } })
    await db.chat_groups.deleteMany({ where: { id: { in: groups.map((g) => g.id) } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => jest.clearAllMocks())

const PRIVATE = `https://${process.env.TIGRIS_PRIVATE_BUCKET || `${process.env.TIGRIS_BUCKET || "blendn-media"}-private`}.fly.storage.tigris.dev`
const sealed = () => `chat/sealed/${randomUUID()}`
const urlOf = (key: string) => `${PRIVATE}/${key}`

async function world() {
  const me = await makeUser(testId("cme_me"))
  const other = await makeUser(testId("cme_other"))
  const owner = await makeUser(testId("cme_own"), "organizer")
  users.push(me, other, owner)
  const event = await db.events.create({
    data: {
      slug: testId("cme"),
      title: `Room ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(Date.now() - HOUR),
      end_time: new Date(Date.now() + HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  const group = await db.chat_groups.create({ data: { event_id: event.id, name: "room", status: "active" } })
  const conversation = await db.private_conversations.create({
    data: { user1_id: me, user2_id: other, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })
  conversations.push(conversation.id)

  const room = (by: string, key: string, moderation_status: string | null = null) =>
    db.chat_messages.create({
      data: { chat_group_id: group.id, user_id: by, content: "photo", type: "image", metadata: { mediaUrl: urlOf(key) }, moderation_status },
    })
  const dm = (by: string, key: string, moderation_status: string | null = null) =>
    db.private_messages.create({
      data: { conversation_id: conversation.id, sender_id: by, media_url: urlOf(key), media_type: "image", moderation_status },
    })

  const keys = { roomPlain: sealed(), roomHidden: sealed(), dmPlain: sealed(), dmHidden: sealed(), theirs: sealed() }
  const legacy = `chat/${me}/1790641297767-abc123-sealed`
  await room(me, keys.roomPlain)
  await room(me, keys.roomHidden, "hidden")
  await dm(me, keys.dmPlain)
  await dm(me, keys.dmHidden, "hidden")
  await room(other, keys.theirs)
  await room(me, legacy)
  return { me, keys, legacy }
}

it("finds a person's sealed copies through their own messages, in rooms and DMs, and nobody else's", async () => {
  const { me, keys } = await world()

  expect([...(await sentChatMediaKeys(me))].sort()).toEqual(
    [keys.roomPlain, keys.roomHidden, keys.dmPlain, keys.dmHidden].sort()
  )
})

it("keeps a removed message's sealed copy as well as an older one under chat/<id>/", async () => {
  const { me, keys, legacy } = await world()
  const kept = await retainedChatMediaKeys(me)

  expect(kept.has(keys.roomHidden)).toBe(true)
  expect(kept.has(keys.dmHidden)).toBe(true)
  expect(kept.has(keys.roomPlain)).toBe(false)
  expect(kept.has(legacy)).toBe(false)
})

it("account deletion erases the uploads by prefix and every sealed copy except the kept ones", async () => {
  const { me, keys } = await world()
  const kept = await retainedChatMediaKeys(me)

  await eraseChatMedia(me, kept)

  expect(deletePrefix).toHaveBeenCalledWith(`chat/${me}/`, kept)
  expect((deleteFile as jest.Mock).mock.calls.map(([k]) => k).sort()).toEqual([keys.roomPlain, keys.dmPlain].sort())
})

it("the purge erases the kept copies too", async () => {
  const { me, keys } = await world()

  await eraseChatMedia(me, new Set())

  expect((deleteFile as jest.Mock).mock.calls.map(([k]) => k).sort()).toEqual(
    [keys.roomPlain, keys.roomHidden, keys.dmPlain, keys.dmHidden].sort()
  )
})
