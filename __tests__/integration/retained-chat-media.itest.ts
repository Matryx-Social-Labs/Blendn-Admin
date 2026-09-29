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

  const room = (name: string, moderation_status: string | null = null) =>
    db.chat_messages.create({
      data: {
        chat_group_id: group.id,
        user_id: me,
        content: name,
        type: "image",
        metadata: { mediaUrl: url(me, name) },
        moderation_status,
      },
    })
  await room("room-plain")
  await room("room-hidden", "hidden")
  await room("room-flagged-status", "flagged")
  const flagged = await room("room-flag-row")
  await db.moderation_flags.create({
    data: {
      message_id: flagged.id,
      chat_group_id: group.id,
      user_id: me,
      source: "auto_image",
      categories: { sexual: 0.9 },
      confidence: 0.9,
    },
  })
  const reportedRoom = await room("room-reported")
  await db.message_reports.create({
    data: { reporter_id: other, message_id: reportedRoom.id, message_type: "group", reason: "harassment" },
  })
  // Hidden, but no image: nothing to keep.
  await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: me, content: "text only", type: "text", moderation_status: "hidden" },
  })

  const conversation = await db.private_conversations.create({
    data: { user1_id: me, user2_id: other, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })
  conversations.push(conversation.id)
  const dm = (sender: string, name: string, moderation_status: string | null = null) =>
    db.private_messages.create({
      data: {
        conversation_id: conversation.id,
        sender_id: sender,
        media_url: url(sender, name),
        media_type: "image",
        moderation_status,
      },
    })
  await dm(me, "dm-plain")
  await dm(me, "dm-hidden", "hidden")
  const reportedDm = await dm(me, "dm-reported")
  await db.message_reports.create({
    data: { reporter_id: other, message_id: reportedDm.id, message_type: "private", reason: "spam" },
  })
  // Someone else's hidden image is theirs to keep or lose, not mine.
  await dm(other, "their-hidden", "hidden")

  const kept = await retainedChatMediaKeys(me)
  expect([...kept].sort()).toEqual(
    [
      key(me, "room-hidden"),
      key(me, "room-flagged-status"),
      key(me, "room-flag-row"),
      key(me, "room-reported"),
      key(me, "dm-hidden"),
      key(me, "dm-reported"),
    ].sort()
  )
})
