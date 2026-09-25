import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { sweepExpiredChats } from "@/lib/chat-lifecycle"
import { chatClosedMessage, chatWindowState, CHAT_WINDOW_HOURS } from "@/lib/chat-window"
import { signAccessToken } from "@/lib/mobile-auth"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const reactionsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route")

/**
 * The sweep against real rows.
 *
 * Two properties matter more than the happy path:
 *
 *   1. It is idempotent. Both writes filter on the state they are leaving, so a
 *      second pass matches nothing — which is what makes it safe to run from
 *      every replica without coordination and safe to trigger manually while
 *      the timer is also running.
 *   2. It is not load-bearing. Writes are already refused for an expired room
 *      before the sweep has touched it, because `chatWindowState` reads the
 *      event's own end_time. If that ever stops being true, a late or stuck job
 *      silently becomes a hole.
 */

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

async function makeExpiredRoom(opts: { endedHoursAgo: number }) {
  const owner = await makeUser(testId("sweep_owner"), "organizer")
  users.push(owner)
  const slug = testId("sweep")
  const end = new Date(Date.now() - opts.endedHoursAgo * HOUR)
  const event = await db.events.create({
    data: {
      slug,
      title: `Sweep ${slug}`,
      description: "integration fixture",
      start_time: new Date(end.getTime() - 2 * HOUR),
      end_time: end,
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  const group = await db.chat_groups.create({
    data: { event_id: event.id, name: `${slug} chat`, status: "active" },
  })
  return { eventId: event.id, groupId: group.id, endTime: end }
}

afterAll(async () => {
  if (events.length) await db.events.deleteMany({ where: { id: { in: events } } })
  await cleanup(users, [])
  await closeDb()
})

describe("sweepExpiredChats", () => {
  it("archives an expired room and releases its members", async () => {
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: CHAT_WINDOW_HOURS + 2 })

    const [active, muted, banned] = await Promise.all([
      makeUser(testId("m_active")),
      makeUser(testId("m_muted")),
      makeUser(testId("m_banned")),
    ])
    users.push(active, muted, banned)
    await db.chat_group_members.createMany({
      data: [
        { chat_group_id: groupId, user_id: active, status: "active" },
        { chat_group_id: groupId, user_id: muted, status: "muted" },
        { chat_group_id: groupId, user_id: banned, status: "banned" },
      ],
    })

    await sweepExpiredChats()

    const group = await db.chat_groups.findUniqueOrThrow({ where: { id: groupId } })
    expect(group.status).toBe("archived")

    const members = await db.chat_group_members.findMany({
      where: { chat_group_id: groupId },
      select: { user_id: true, status: true },
    })
    const byUser = Object.fromEntries(members.map((m) => [m.user_id, m.status]))
    expect(byUser[active]).toBe("left")
    expect(byUser[muted]).toBe("left")
    // A ban is a moderation record and must outlive the room closing.
    expect(byUser[banned]).toBe("banned")
  })

  it("keeps membership rows so historical pseudonyms still resolve", async () => {
    // Deleting members would strip the anonymous names off every past message,
    // which anonymises nobody and breaks the feedback digest.
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: CHAT_WINDOW_HOURS + 2 })
    const member = await makeUser(testId("m_pseudo"))
    users.push(member)
    await db.chat_group_members.create({
      data: {
        chat_group_id: groupId,
        user_id: member,
        status: "active",
        anonymous_name: "Quiet Otter",
      },
    })

    await sweepExpiredChats()

    const row = await db.chat_group_members.findFirstOrThrow({
      where: { chat_group_id: groupId, user_id: member },
    })
    expect(row.anonymous_name).toBe("Quiet Otter")
  })

  it("leaves a room whose window is still open", async () => {
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: 1 })
    await sweepExpiredChats()
    const group = await db.chat_groups.findUniqueOrThrow({ where: { id: groupId } })
    expect(group.status).toBe("active")
  })

  it("is idempotent — a second pass changes nothing", async () => {
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: CHAT_WINDOW_HOURS + 2 })
    const member = await makeUser(testId("m_idem"))
    users.push(member)
    await db.chat_group_members.create({
      data: { chat_group_id: groupId, user_id: member, status: "active" },
    })

    const first = await sweepExpiredChats()
    expect(first.archived).toBeGreaterThan(0)

    const second = await sweepExpiredChats()
    // Nothing left matching `status: active`, so the second pass is a no-op.
    // This is the property that makes replica duplication safe.
    expect(second.archived).toBe(0)
    expect(second.released).toBe(0)
  })
})

describe("the sweep is not what stops people posting", () => {
  it("refuses writes to an expired room the sweep has not touched yet", async () => {
    // The failure this guards: a stuck or late job silently becoming a hole.
    // The gate reads the event's own end_time, so a room still flagged active
    // is already closed.
    const { groupId, endTime } = await makeExpiredRoom({
      endedHoursAgo: CHAT_WINDOW_HOURS + 5,
    })

    const group = await db.chat_groups.findUniqueOrThrow({ where: { id: groupId } })
    expect(group.status).toBe("active")

    const state = chatWindowState({ end_time: endTime, deleted_at: null }, group)
    expect(state.open).toBe(false)
    if (!state.open) expect(state.reason).toBe("window_closed")
  })
})

/*
 * A closed room refuses a reaction the way it refuses a message (SCRUM-154).
 *
 * Driven on Android: the post got "This chat has closed. Event chats stay open
 * for 24 hours after the event ends." and `CHAT_CLOSED`; the heart on the last
 * message got "This room is not open" and no code. Same gate, two answers.
 */
describe("a closed room refuses a reaction with the same words as a message", () => {
  const post = (token: string, groupId: string, body: unknown) =>
    new NextRequest(`http://localhost/api/mobile/chat/groups/${groupId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

  it("window closed → CHAT_CLOSED and the sentence that says when", async () => {
    const { groupId } = await makeExpiredRoom({ endedHoursAgo: CHAT_WINDOW_HOURS + 5 })
    const memberId = await makeUser(testId("react_member"), "attendee")
    users.push(memberId)
    const member = await db.user.findUniqueOrThrow({ where: { id: memberId }, select: { email: true } })
    const token = signAccessToken(memberId, member.email)
    await db.chat_group_members.create({
      data: { chat_group_id: groupId, user_id: memberId, status: "active", anonymous_name: "Late Owl" },
    })
    const message = await db.chat_messages.create({
      data: { chat_group_id: groupId, user_id: memberId, content: "last word", type: "text" },
    })

    const msg = await messagesRoute.POST(post(token, groupId, { content: "one more" }), {
      params: Promise.resolve({ chatGroupId: groupId }),
    })
    const react = await reactionsRoute.POST(
      post(token, `${groupId}/messages/${message.id}/reactions`, { emoji: "🔥" }),
      { params: Promise.resolve({ chatGroupId: groupId, messageId: message.id }) }
    )
    const [m, r] = await Promise.all([msg.json(), react.json()])
    expect([msg.status, react.status]).toEqual([403, 403])
    expect(r).toMatchObject({ errorCode: "CHAT_CLOSED", error: chatClosedMessage("window_closed") })
    expect(r.error).toBe(m.error)
    expect(await db.message_reactions.count({ where: { message_id: message.id } })).toBe(0)
  })

  it("muted by the organiser → USER_MUTED and the organiser's sentence", async () => {
    const { groupId, eventId } = await makeExpiredRoom({ endedHoursAgo: 0.5 })
    // Not expired for this one — the window is open; only the mute refuses.
    await db.events.update({ where: { id: eventId }, data: { end_time: new Date(Date.now() + HOUR) } })
    const memberId = await makeUser(testId("react_muted"), "attendee")
    users.push(memberId)
    const member = await db.user.findUniqueOrThrow({ where: { id: memberId }, select: { email: true } })
    const token = signAccessToken(memberId, member.email)
    await db.chat_group_members.create({
      data: {
        chat_group_id: groupId,
        user_id: memberId,
        status: "muted",
        muted_at: new Date(),
        muted_by: users[0],
        anonymous_name: "Quiet Fox",
      },
    })
    const message = await db.chat_messages.create({
      data: { chat_group_id: groupId, user_id: memberId, content: "before the mute", type: "text" },
    })

    const react = await reactionsRoute.POST(
      post(token, `${groupId}/messages/${message.id}/reactions`, { emoji: "🔥" }),
      { params: Promise.resolve({ chatGroupId: groupId, messageId: message.id }) }
    )
    expect(react.status).toBe(403)
    expect(await react.json()).toMatchObject({
      errorCode: "USER_MUTED",
      error: "The organiser has muted you in this room.",
    })
  })
})
