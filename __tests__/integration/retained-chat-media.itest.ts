/*
 * Which of a person's chat images outlive their account (SCRUM-428).
 *
 * Account deletion erases `chat/<id>/`, except the images in messages that are
 * removed content: hidden or flagged by moderation, carrying a moderation
 * flag, or reported. Those are kept 180 days (docs/RETENTION.md, IT Rules 2021
 * r.3(1)(g)), in rooms and in DMs alike. Everything else goes.
 */
import { db, closeDb, makeUser, testId } from "./helpers"
import { retainedChatMediaKeys } from "@/lib/retained-media"

const users: string[] = []
const events: string[] = []
const conversations: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (conversations.length) {
    await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (events.length) {
    const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
    const groupIds = groups.map((g) => g.id)
    await db.moderation_flags.deleteMany({ where: { chat_group_id: { in: groupIds } } })
    await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groupIds } } })
    await db.chat_groups.deleteMany({ where: { id: { in: groupIds } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

const HOST = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}.fly.storage.tigris.dev`
const key = (userId: string, name: string) => `chat/${userId}/1790641297767-abc123-${name}.jpg`
const url = (userId: string, name: string) => `${HOST}/${key(userId, name)}`

it("keeps the images of hidden, flagged and reported messages, in rooms and DMs, and nothing else", async () => {
  const me = await makeUser(testId("rc_me"))
  const other = await makeUser(testId("rc_other"))
  users.push(me, other)

  const owner = await makeUser(testId("rc_own"), "organizer")
  users.push(owner)
  const event = await db.events.create({
    data: {
      slug: testId("rc"),
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

  const room = (
    name: string,
    moderation_status: string | null = null,
    extra: { user_id?: string; deleted_at?: Date; deleted_by?: string } = {}
  ) =>
    db.chat_messages.create({
      data: {
        chat_group_id: group.id,
        user_id: extra.user_id ?? me,
        content: name,
        type: "image",
        metadata: { mediaUrl: url(me, name) },
        moderation_status,
        ...(extra.deleted_at && { deleted_at: extra.deleted_at, deleted_by: extra.deleted_by }),
      },
    })
  const flag = (messageId: string, status?: "pending" | "approved" | "rejected") =>
    db.moderation_flags.create({
      data: {
        message_id: messageId,
        chat_group_id: group.id,
        user_id: me,
        source: "auto_image",
        categories: { sexual: 0.9 },
        confidence: 0.9,
        ...(status && { status }),
      },
    })
  const report = (messageId: string, type: "group" | "private", by: string, status?: "pending" | "reviewed" | "resolved") =>
    db.message_reports.create({
      data: { reporter_id: by, message_id: messageId, message_type: type, reason: "harassment", ...(status && { status }) },
    })
  await room("room-plain")
  await room("room-hidden", "hidden")
  await room("room-flagged-status", "flagged")
  await flag((await room("room-flag-row")).id)
  await report((await room("room-reported")).id, "group", other)
  await room("room-host-deleted", null, { deleted_at: new Date(), deleted_by: owner })
  // Cleared or dismissed is not removed content; nor is the author's own act.
  await flag((await room("room-flag-cleared")).id, "approved")
  await report((await room("room-report-dismissed")).id, "group", other, "reviewed")
  await report((await room("room-self-reported")).id, "group", me)
  await room("room-self-deleted", null, { deleted_at: new Date(), deleted_by: me })
  // Somebody else's removed message carrying my key: scoped to my own messages.
  await room("room-theirs-with-my-key", "hidden", { user_id: other })
  // Hidden, but no image: nothing to keep.
  await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: me, content: "text only", type: "text", moderation_status: "hidden" },
  })

  const conversation = await db.private_conversations.create({
    data: { user1_id: me, user2_id: other, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })
  conversations.push(conversation.id)
  const dm = (sender: string, name: string, moderation_status: string | null = null, owner = sender) =>
    db.private_messages.create({
      data: {
        conversation_id: conversation.id,
        sender_id: sender,
        media_url: url(owner, name),
        media_type: "image",
        moderation_status,
      },
    })
  await dm(me, "dm-plain")
  await dm(me, "dm-hidden", "hidden")
  await dm(me, "dm-flagged", "flagged")
  await report((await dm(me, "dm-reported")).id, "private", other)
  await report((await dm(me, "dm-report-dismissed")).id, "private", other, "reviewed")
  await report((await dm(me, "dm-self-reported")).id, "private", me)
  // Someone else's hidden image is theirs; and their hidden DM carrying my key is not my message.
  await dm(other, "their-hidden", "hidden")
  await dm(other, "dm-theirs-with-my-key", "hidden", me)

  const kept = await retainedChatMediaKeys(me)
  expect([...kept].sort()).toEqual(
    [
      key(me, "room-hidden"),
      key(me, "room-flagged-status"),
      key(me, "room-flag-row"),
      key(me, "room-reported"),
      key(me, "room-host-deleted"),
      key(me, "dm-hidden"),
      key(me, "dm-flagged"),
      key(me, "dm-reported"),
    ].sort()
  )
})
