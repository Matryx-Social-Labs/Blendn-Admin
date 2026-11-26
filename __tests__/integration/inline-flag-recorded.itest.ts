import { NextRequest } from "next/server"

/*
 * A line the inline check flagged, and did not hide, is delivered AND recorded
 * for review, on both room send routes (SCRUM-1167).
 *
 * Two kinds of flag: the model's own (a score between the flag and hide bars)
 * and a keyword one (an ordinary word on the review list, such as "chod"). In
 * each case the line reaches the room, a pending `moderation_flags` row exists
 * (what the dashboard queue reads), the message is `flagged` and not `clean`,
 * and the sender is never muted for it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockCheckText = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  ...jest.requireActual("@/lib/moderation/openai-moderation"),
  checkTextContent: (...a: unknown[]) => mockCheckText(...a),
}))
const emitted: string[] = []
jest.mock("@/lib/socket-server", () => ({
  ...jest.requireActual("@/lib/socket-server"),
  emitChatMessage: (...a: unknown[]) => void emitted.push((a[1] as { content: string }).content),
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { clearAllSpamHistory } from "@/lib/moderation/spam-detector"
import { recordTextSuccess } from "@/lib/moderation/text-breaker"
import { db, closeDb, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as
  typeof import("@/app/api/mobile/events/[eventId]/chat/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  await clearAllSpamHistory()
  const groupIds = (await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })).map((g) => g.id)
  await db.moderation_flags.deleteMany({ where: { chat_group_id: { in: groupIds } } })
  await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groupIds } } })
  await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: groupIds } } })
  await db.chat_groups.deleteMany({ where: { id: { in: groupIds } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveRoom() {
  const owner = await makeUser(testId("if_own"), "organizer")
  const memberId = await makeUser(testId("if_m"))
  users.push(owner, memberId)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("if"),
      title: `Room ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now - HOUR),
      end_time: new Date(now + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  const group = await db.chat_groups.create({ data: { event_id: event.id, name: "room", status: "active" } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: memberId, anonymous_name: `Pseudo ${testId("x")}` } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: memberId }, select: { email: true } })
  return { eventId: event.id, groupId: group.id, memberId, token: signAccessToken(memberId, email) }
}
type Room = Awaited<ReturnType<typeof liveRoom>>

const post = (url: string, token: string, content: string) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, type: "text" }),
  })
const send = (which: "group" | "event", r: Room, content: string) =>
  which === "group"
    ? groupRoute.POST(post(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, r.token, content), { params: Promise.resolve({ chatGroupId: r.groupId }) })
    : eventRoute.POST(post(`http://localhost/api/mobile/events/${r.eventId}/chat`, r.token, content), { params: Promise.resolve({ eventId: r.eventId }) })

/** The flag and the status are written off the response path: give them a moment. */
async function settled(groupId: string, content: string) {
  for (let i = 0; i < 40; i++) {
    const message = await db.chat_messages.findFirst({ where: { chat_group_id: groupId, content }, select: { id: true, moderation_status: true, deleted_at: true } })
    const flags = message ? await db.moderation_flags.findMany({ where: { message_id: message.id }, select: { source: true, status: true, auto_action: true } }) : []
    if (message?.moderation_status && message.moderation_status !== "pending") return { message, flags }
    await new Promise((ok) => setTimeout(ok, 50))
  }
  throw new Error(`no verdict recorded for ${content}`)
}

const CLEAN = { checked: true, result: null }
const MODEL_FLAG = { checked: true, result: { action: "flag", source: "openai_text", categories: { harassment: 0.5 }, confidence: 0.5 } }

beforeEach(async () => {
  mockCheckText.mockReset()
  emitted.length = 0
  recordTextSuccess()
  await clearAllSpamHistory()
  process.env.OPENAI_API_KEY = "sk-itest"
})

describe.each(["group", "event"] as const)("%s route, the inline check answered", (which) => {
  it("a keyword flag (an ordinary word on the review list) is delivered and recorded for review, not marked clean", async () => {
    const r = await liveRoom()
    mockCheckText.mockResolvedValue(CLEAN)
    expect((await send(which, r, "chod yaar, let's go")).status).toBe(201)
    expect(emitted).toEqual(["chod yaar, let's go"])
    const { message, flags } = await settled(r.groupId, "chod yaar, let's go")
    expect(message).toMatchObject({ moderation_status: "flagged", deleted_at: null })
    expect(flags).toEqual([{ source: "auto_keyword", status: "pending", auto_action: "none" }])
  })

  it("the model's flag is delivered and recorded for review, not marked clean", async () => {
    const r = await liveRoom()
    mockCheckText.mockResolvedValue(MODEL_FLAG)
    expect((await send(which, r, "borderline line")).status).toBe(201)
    expect(emitted).toEqual(["borderline line"])
    const { message, flags } = await settled(r.groupId, "borderline line")
    expect(message.moderation_status).toBe("flagged")
    expect(flags).toEqual([{ source: "auto_text", status: "pending", auto_action: "none" }])
  })

  it("an ordinary line is still clean, with no flag (control)", async () => {
    const r = await liveRoom()
    mockCheckText.mockResolvedValue(CLEAN)
    await send(which, r, "see you at nine")
    const { message, flags } = await settled(r.groupId, "see you at nine")
    expect(message.moderation_status).toBe("clean")
    expect(flags).toEqual([])
  })

  it("three keyword flags in an hour never mute the sender", async () => {
    const r = await liveRoom()
    mockCheckText.mockResolvedValue(CLEAN)
    for (const line of ["chod yaar", "chod yaar, seriously", "chod yaar, ok last one"]) {
      expect((await send(which, r, line)).status).toBe(201)
      await settled(r.groupId, line)
    }
    const member = await db.chat_group_members.findFirstOrThrow({ where: { chat_group_id: r.groupId, user_id: r.memberId }, select: { status: true, muted_by: true } })
    expect(member).toEqual({ status: "active", muted_by: null })
  })
})
