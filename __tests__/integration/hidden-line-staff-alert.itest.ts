import { NextRequest } from "next/server"

/*
 * A line the keyword list hid, from the send route to the staff alert's sweep
 * (SCRUM-1474). The model's verdict decides what staff hear: a clean verdict,
 * nothing; a threat below its hide line, a severe flag; no verdict, the line
 * "hidden lines the model could not judge". None of them mutes.
 *
 * The unjudged line is said once and then held for 15 minutes, so the test
 * that expects it reads a sweeper of its own. Its exact count is
 * staff-alert.itest.ts's.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// The model, by what the line says: "[threat]" a threat below its hide line, "[down]" a failed call.
jest.mock("@/lib/moderation/openai-moderation", () => {
  const actual = jest.requireActual("@/lib/moderation/openai-moderation")
  return {
    ...actual,
    checkTextContent: jest.fn(async (content: string) =>
      content.includes("[down]")
        ? { checked: false, reason: "error" }
        : content.includes("[threat]")
          ? { checked: true, result: { action: "flag", source: "openai_text", categories: { "harassment/threatening": 0.55 }, confidence: 0.55 } }
          : { checked: true, result: null }
    ),
  }
})

import { signAccessToken } from "@/lib/mobile-auth"
import { AUTO_MUTE_HIDDEN_COUNT } from "@/lib/moderation/config"
import { MODERATION_TIMEOUT_MS } from "@/lib/moderation/openai-moderation"
import { runStaffAlertSweep } from "@/lib/staff-alert"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000
let fetchMock: jest.Mock

beforeAll(() => {
  process.env.STAFF_ALERT_SLACK_WEBHOOK_URL = "http://127.0.0.1:9/hidden-line-itest"
  delete process.env.REDIS_URL
  fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => "ok" })
  global.fetch = fetchMock as unknown as typeof fetch
})

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
  const owner = await makeUser(testId("hl_own"), "organizer")
  const memberId = await makeUser(testId("hl_m"))
  users.push(owner, memberId)
  await onboard(memberId)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("hl"),
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
  return { groupId: group.id, memberId, token: signAccessToken(memberId, email) }
}

type Room = Awaited<ReturnType<typeof liveRoom>>

async function sendHidden(r: Room, content: string) {
  const req = new NextRequest(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
    body: JSON.stringify({ content, type: "text" }),
  })
  const res = await groupRoute.POST(req, { params: Promise.resolve({ chatGroupId: r.groupId }) })
  expect(res.status).toBe(200)
  expect((await res.json()).data).toMatchObject({ content: null, moderation_hidden: true })
}

const pause = () => new Promise((res) => setTimeout(res, 50))

/** The flags are written after the response, and the marker removed once the model answers: poll until `done`, bounded. */
async function flagsWhen(r: Room, done: (flags: { source: string; categories: object }[]) => boolean) {
  for (let i = 0; ; i++) {
    const flags = await db.moderation_flags.findMany({
      where: { chat_group_id: r.groupId, user_id: r.memberId },
      select: { source: true, categories: true },
    })
    if (done(flags as { source: string; categories: object }[]) || i === 80) return flags
    await pause()
  }
}

const memberStatus = async (r: Room) =>
  (await db.chat_group_members.findUniqueOrThrow({ where: { chat_group_id_user_id: { chat_group_id: r.groupId, user_id: r.memberId } } })).status

/** Closes the window at now: the sweep reads 10 s behind the time it is given. */
async function sweep(): Promise<string | null> {
  fetchMock.mockClear()
  await runStaffAlertSweep(new Date(Date.now() + 10_000))
  return fetchMock.mock.calls.length ? (JSON.parse(fetchMock.mock.calls[0][1].body).text as string) : null
}

const keys = (f: { categories: unknown }) => Object.keys(f.categories as object).sort().join()

it("sends nothing for a swear-word hide the model calls clean, and does not mute", async () => {
  const r = await liveRoom()
  await sweep()
  for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, `${i} chutiya`)
  const flags = await flagsWhen(r, (f) => f.length === AUTO_MUTE_HIDDEN_COUNT && f.every((x) => keys(x) === "profanity"))
  expect(flags.map(keys)).toEqual(Array(AUTO_MUTE_HIDDEN_COUNT).fill("profanity"))
  expect(await sweep()).toBeNull()
  expect(await memberStatus(r)).toBe("active")
})

it("alerts a swear-word hide the model flags as a threat as a severe flag, and does not mute", async () => {
  const r = await liveRoom()
  await sweep()
  await sendHidden(r, "[threat] chutiya")
  const flags = await flagsWhen(r, (f) => f.some((x) => x.source === "auto_text") && f.every((x) => !keys(x).includes("unjudged")))
  expect(flags.map(keys).sort()).toEqual(["harassment/threatening", "profanity"])
  const text = await sweep()
  expect(text).toContain("1 severe flag;")
  expect(text).not.toContain("could not judge")
  expect(await memberStatus(r)).toBe("active")
})

it("tells staff about swear-word hides the model could not judge, in one message, and mutes nobody", async () => {
  const r = await liveRoom()
  for (let i = 1; i <= AUTO_MUTE_HIDDEN_COUNT; i++) await sendHidden(r, `${i} [down] chutiya`)
  const flags = await flagsWhen(r, (f) => f.length === AUTO_MUTE_HIDDEN_COUNT)
  expect(flags.map(keys)).toEqual(Array(AUTO_MUTE_HIDDEN_COUNT).fill("profanity,unjudged"))
  // A sweeper just booted: what this database held before is no concern of this test.
  let fresh!: typeof import("@/lib/staff-alert")
  jest.isolateModules(() => {
    fresh = require("@/lib/staff-alert") // eslint-disable-line @typescript-eslint/no-require-imports
  })
  const sweepFresh = async (settleMs: number) => {
    fetchMock.mockClear()
    await fresh.runStaffAlertSweep(new Date(Date.now() + 10_000 + settleMs))
    return fetchMock.mock.calls.length ? (JSON.parse(fetchMock.mock.calls[0][1].body).text as string) : null
  }
  // Past the settle delay: an answer that was still on its way would have arrived.
  const text = await sweepFresh(2 * MODERATION_TIMEOUT_MS)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const said = Number(/(\d+) hidden lines the model could not judge\./.exec(text ?? "")?.[1])
  expect(said).toBeGreaterThanOrEqual(AUTO_MUTE_HIDDEN_COUNT)
  expect(await memberStatus(r)).toBe("active")
})
