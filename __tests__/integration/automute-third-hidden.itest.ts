import { NextRequest } from "next/server"

/*
 * Three hidden messages mute the sender on the third, not a fourth (SCRUM-483).
 *
 * Found on staging: three keyword-hidden messages in an hour, then a clean one
 * -- delivered to the room. The mute landed on the fourth. The keyword branch
 * fired `flagForReview` and `checkAndAutoMute` side by side, both unawaited, so
 * the count ran before the current message's flag was written; the log read
 * `auto-muted … hiddenCount=3` seven milliseconds before that message's own
 * `flagged for review`.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// Only the keyword branch is under test; it returns before the pipeline runs.
jest.mock("@/lib/moderation", () => ({
  ...jest.requireActual("@/lib/moderation"),
  moderateMessage: jest.fn().mockResolvedValue(undefined),
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { AUTO_MUTE_HIDDEN_COUNT } from "@/lib/moderation/config"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

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
  const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
  const groupIds = groups.map((g) => g.id)
  await db.moderation_flags.deleteMany({ where: { chat_group_id: { in: groupIds } } })
  await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groupIds } } })
  await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: groupIds } } })
  await db.chat_groups.deleteMany({ where: { id: { in: groupIds } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveRoom() {
  const owner = await makeUser(testId("am_own"), "organizer")
  const memberId = await makeUser(testId("am_m"))
  users.push(owner, memberId)
  await onboard(memberId)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("am"),
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
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  const group = await db.chat_groups.create({ data: { event_id: event.id, name: "room", status: "active" } })
  await db.chat_group_members.create({
    data: { chat_group_id: group.id, user_id: memberId, anonymous_name: `Pseudo ${testId("x")}` },
  })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: memberId }, select: { email: true } })
  return { eventId: event.id, groupId: group.id, memberId, token: signAccessToken(memberId, email) }
}

type Room = Awaited<ReturnType<typeof liveRoom>>

const post = (url: string, token: string, body: object) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

const ROUTES = [
  [
    "group route",
    (r: Room, content: string) =>
      groupRoute.POST(post(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, r.token, { content, type: "text" }), {
        params: Promise.resolve({ chatGroupId: r.groupId }),
      }),
  ],
  [
    "event route",
    (r: Room, content: string) =>
      eventRoute.POST(post(`http://localhost/api/mobile/events/${r.eventId}/chat`, r.token, { content, type: "text" }), {
        params: Promise.resolve({ eventId: r.eventId }),
      }),
  ],
] as const

type State = { written: number; status: string; muted_by: string | null }

/** The flag and the mute are written after the response: poll until `done`, bounded. */
async function stateOf(r: Room, done: (s: State) => boolean): Promise<State> {
  for (let i = 0; ; i++) {
    const [written, member] = await Promise.all([
      db.moderation_flags.count({ where: { chat_group_id: r.groupId, user_id: r.memberId, auto_action: "hidden" } }),
      db.chat_group_members.findUniqueOrThrow({
        where: { chat_group_id_user_id: { chat_group_id: r.groupId, user_id: r.memberId } },
        select: { status: true, muted_by: true },
      }),
    ])
    const s = { written, ...member }
    if (done(s) || i === 79) return s
    await new Promise((res) => setTimeout(res, 25))
  }
}

describe.each(ROUTES)("the %s", (_name, send) => {
  it(`mutes on hidden message number ${AUTO_MUTE_HIDDEN_COUNT}, and refuses the next clean one`, async () => {
    const r = await liveRoom()

    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) {
      const res = await send(r, `probe ${i}: you are a retard`)
      expect(res.status).toBe(200)
      // Sent one after another, as the phone does: each answer before the next send.
      await stateOf(r, (s) => s.written === i)
    }

    expect(await stateOf(r, (s) => s.status === "muted")).toEqual({
      written: AUTO_MUTE_HIDDEN_COUNT,
      status: "muted",
      // Automatic, so the hour can lift it.
      muted_by: null,
    })

    const clean = await send(r, "hello again")
    expect(clean.status).toBe(403)
    expect((await clean.json()).errorCode).toBe("USER_MUTED")
    expect(await db.chat_messages.count({ where: { chat_group_id: r.groupId, content: "hello again" } })).toBe(0)
  })

  it("never mutes for contact details alone, however many", async () => {
    // Sharing your own number is hidden and flagged, not abuse (`autoMute: false`).
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) {
      expect((await send(r, `call me on 98765 4321${i} tonight`)).status).toBe(200)
      await stateOf(r, (s) => s.written === i)
    }
    // Long enough for a mute that was coming to have landed.
    await new Promise((res) => setTimeout(res, 300))
    expect(await stateOf(r, () => true)).toEqual({ written: AUTO_MUTE_HIDDEN_COUNT, status: "active", muted_by: null })
    expect((await send(r, "hello again")).status).toBe(201)
  })
})
