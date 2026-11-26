import { NextRequest } from "next/server"

/*
 * Which hides mute (D-052a, SCRUM-1469). A line the keyword list hides for a
 * swear word stays hidden, and it does not count toward the automatic mute: a
 * mute needs three lines the model itself judged abusive, or a slur aimed at a
 * person. The model still judges a keyword-hidden line, after the response, so
 * an abusive line that also carries a listed word counts.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// The model, by what the line says: "[abuse]" is what it judges abusive, "[threat]" a threat below its hide
// line, "[down]" a failed call.
jest.mock("@/lib/moderation/openai-moderation", () => {
  const actual = jest.requireActual("@/lib/moderation/openai-moderation")
  return {
    ...actual,
    checkTextContent: jest.fn(async (content: string) =>
      content.includes("[down]")
        ? { checked: false, reason: "error" }
        : content.includes("[abuse]")
          ? { checked: true, result: { action: "hide", source: "openai_text", categories: { harassment: 0.97 }, confidence: 0.97 } }
          : content.includes("[threat]")
            ? { checked: true, result: { action: "flag", source: "openai_text", categories: { "harassment/threatening": 0.55 }, confidence: 0.55 } }
            : { checked: true, result: null }
    ),
  }
})

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
  const owner = await makeUser(testId("kh_own"), "organizer")
  const memberId = await makeUser(testId("kh_m"))
  users.push(owner, memberId)
  await onboard(memberId)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("kh"),
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
  return { eventId: event.id, groupId: group.id, memberId, owner, token: signAccessToken(memberId, email) }
}

type Room = Awaited<ReturnType<typeof liveRoom>>

const post = (url: string, token: string, body: object) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })

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

type State = { flags: number; status: string; muted_at: Date | null; muted_by: string | null }

/** Flags and the mute are written after the response: poll until `done`, bounded. */
async function stateOf(r: Room, done: (s: State) => boolean): Promise<State> {
  for (let i = 0; ; i++) {
    const [flags, member] = await Promise.all([
      db.moderation_flags.count({ where: { chat_group_id: r.groupId, user_id: r.memberId, auto_action: "hidden" } }),
      db.chat_group_members.findUniqueOrThrow({
        where: { chat_group_id_user_id: { chat_group_id: r.groupId, user_id: r.memberId } },
        select: { status: true, muted_at: true, muted_by: true },
      }),
    ])
    const s = { flags, ...member }
    if (done(s) || i === 79) return s
    await new Promise((res) => setTimeout(res, 25))
  }
}

/** Sent one after another, as the phone does; each line hidden, and its flags written before the next. */
async function sendHidden(r: Room, send: (r: Room, c: string) => Promise<Response>, content: string, flagsAfter: number) {
  const res = await send(r, content)
  expect(res.status).toBe(200)
  const { data } = await res.json()
  // The group route answers the message, the event route `{ message }`.
  expect(data.message ?? data).toMatchObject({ content: null, moderation_hidden: true })
  await stateOf(r, (s) => s.flags === flagsAfter)
}

/** Long enough for a mute that was coming to have landed. */
const settle = () => new Promise((res) => setTimeout(res, 300))

describe.each(ROUTES)("the %s", (_name, send) => {
  it(`does not mute for ${AUTO_MUTE_HIDDEN_COUNT} swear words the keyword list hid, and the next clean line goes out`, async () => {
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} chutiya`, i)
    await settle()
    expect(await stateOf(r, () => true)).toEqual({ flags: AUTO_MUTE_HIDDEN_COUNT, status: "active", muted_at: null, muted_by: null })
    const flags = await db.moderation_flags.findMany({ where: { chat_group_id: r.groupId, user_id: r.memberId }, select: { source: true, categories: true } })
    expect(flags.every((f) => f.source === "auto_keyword" && Object.keys(f.categories as object).join() === "profanity")).toBe(true)
    expect((await send(r, "hello again")).status).toBe(201)
  })

  it(`mutes for ${AUTO_MUTE_HIDDEN_COUNT} lines the model judged abusive`, async () => {
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} [abuse] you will regret this`, i)
    expect(await stateOf(r, (s) => s.status === "muted")).toMatchObject({ status: "muted", muted_by: null })
  })

  it(`mutes for ${AUTO_MUTE_HIDDEN_COUNT} slurs aimed at a person`, async () => {
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} you faggot`, i)
    expect(await stateOf(r, (s) => s.status === "muted")).toMatchObject({ status: "muted", muted_by: null })
  })

  it("counts an abusive line that also carries a listed swear word", async () => {
    const r = await liveRoom()
    await sendHidden(r, send, "1 chutiya", 1)
    await sendHidden(r, send, "2 bhenchod", 2)
    // Each salted line: the keyword's hide (not counted) and the model's (counted).
    await sendHidden(r, send, "3 [abuse] chutiya I know where you live", 4)
    await sendHidden(r, send, "4 [abuse] chutiya I know where you live", 6)
    await settle()
    expect((await stateOf(r, () => true)).status).toBe("active")
    await sendHidden(r, send, "5 [abuse] chutiya I know where you live", 8)
    expect(await stateOf(r, (s) => s.status === "muted")).toMatchObject({ status: "muted", muted_by: null })
    const counted = await db.moderation_flags.findMany({
      where: { chat_group_id: r.groupId, user_id: r.memberId, source: "auto_text" },
      select: { auto_action: true, categories: true },
    })
    expect(counted).toHaveLength(3)
    expect(counted.every((f) => f.auto_action === "hidden" && "harassment" in (f.categories as object))).toBe(true)
  })

  it("counts a line hidden for a contact detail when the model judged it abusive", async () => {
    const r = await liveRoom()
    // Each line: the contact hide (not counted) and the model's (counted).
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} [abuse] call me on 98765 4321${i} or else`, 2 * i)
    expect(await stateOf(r, (s) => s.status === "muted")).toMatchObject({ status: "muted", muted_by: null })
  })

  it("does not count a keyword-hidden line the model could not judge, and its flag says it was not judged", async () => {
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} [down] chutiya`, i)
    await settle()
    expect(await stateOf(r, () => true)).toEqual({ flags: AUTO_MUTE_HIDDEN_COUNT, status: "active", muted_at: null, muted_by: null })
    const flags = await db.moderation_flags.findMany({ where: { chat_group_id: r.groupId, user_id: r.memberId }, select: { categories: true } })
    expect(flags.map((f) => Object.keys(f.categories as object).sort().join())).toEqual(Array(AUTO_MUTE_HIDDEN_COUNT).fill("profanity,unjudged"))
  })

  it("records a threat the model flagged below its hide line as its own flag, keeps the line hidden, and does not mute", async () => {
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} [threat] chutiya`, i)
    const model = async () =>
      db.moderation_flags.findMany({
        where: { chat_group_id: r.groupId, user_id: r.memberId, source: "auto_text" },
        select: { auto_action: true, categories: true, message: { select: { moderation_status: true } } },
      })
    for (let i = 0; i < 80 && (await model()).length < AUTO_MUTE_HIDDEN_COUNT; i++) await settle()
    await settle()
    const flags = await model()
    expect(flags).toHaveLength(AUTO_MUTE_HIDDEN_COUNT)
    for (const f of flags) {
      expect(f).toMatchObject({ auto_action: "none", categories: { "harassment/threatening": 0.55 }, message: { moderation_status: "hidden" } })
    }
    expect(await stateOf(r, () => true)).toMatchObject({ flags: AUTO_MUTE_HIDDEN_COUNT, status: "active", muted_at: null })
  })

  it(`does not mute for ${AUTO_MUTE_HIDDEN_COUNT} lines with "cunt" in them (D-057)`, async () => {
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} you cunt`, i)
    await settle()
    expect(await stateOf(r, () => true)).toEqual({ flags: AUTO_MUTE_HIDDEN_COUNT, status: "active", muted_at: null, muted_by: null })
    const flags = await db.moderation_flags.findMany({ where: { chat_group_id: r.groupId, user_id: r.memberId }, select: { categories: true } })
    expect(flags.every((f) => Object.keys(f.categories as object).join() === "profanity")).toBe(true)
  })

  it(`mutes for ${AUTO_MUTE_HIDDEN_COUNT} lines calling a person a "retard"`, async () => {
    const r = await liveRoom()
    for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, send, `${i} you retard`, i)
    expect(await stateOf(r, (s) => s.status === "muted")).toMatchObject({ status: "muted", muted_by: null })
  })

  it("leaves a host's mute alone", async () => {
    const r = await liveRoom()
    const room = { chat_group_id: r.groupId, user_id: r.memberId }
    const mutedAt = new Date(Date.now() - 2 * HOUR)
    await db.chat_group_members.update({ where: { chat_group_id_user_id: room }, data: { status: "muted", muted_at: mutedAt, muted_by: r.owner } })
    const res = await send(r, "1 chutiya")
    expect(res.status).toBe(403)
    expect((await res.json()).errorCode).toBe("USER_MUTED")
    await settle()
    expect(await stateOf(r, () => true)).toEqual({ flags: 0, status: "muted", muted_at: mutedAt, muted_by: r.owner })
  })
})
