/**
 * A report that led to action tells the person who filed it (`report_actioned`),
 * and says nothing about whom. A dismissal sends nothing; a reinstatement is not
 * an outcome. Driven through the real moderation action.
 */
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({
  emitChatMessageHidden: jest.fn(),
  evictUserSockets: jest.fn(),
  closeRoomSockets: jest.fn(),
  getIO: () => null,
}))
type Msg = { to: string; channelId?: string; title: string; body: string; data: { type: string } }
const sentMessages: Msg[] = []
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Msg[]) {
      sentMessages.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  }
  return { Expo }
})

import { randomUUID } from "crypto"
import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
import * as push from "@/lib/push-notifications"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
let admin = ""

beforeAll(async () => {
  admin = await makeUser("ra_admin", "app_admin")
  users.push(admin)
  session = { user: { id: admin, role: "app_admin" } }
})

beforeEach(() => {
  sentMessages.length = 0
})

const events: string[] = []

afterAll(async () => {
  await db.event_reports.deleteMany({ where: { user_id: { in: users } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.private_messages.deleteMany({ where: { sender_id: { in: users } } })
  await db.audit_logs.deleteMany({ where: { user_id: admin } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function filed() {
  const reporter = await makeUser(testId("ra_reporter"))
  const reported = await makeUser(testId("ra_reported"))
  users.push(reporter, reported)
  await db.push_tokens.create({ data: { user_id: reporter, token: `ExponentPushToken[${reporter}]`, platform: "android", channel_set: 2 } })
  const report = await db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason: "harassment", status: "pending" } })
  return { reporter, reported, report }
}

it("an upheld report tells its reporter, and the words name nobody", async () => {
  const { reporter, reported, report } = await filed()
  await resolveReport("user", report.id, "suspend")

  const rows = await db.notifications.findMany({ where: { user_id: reporter }, select: { kind: true, title: true, body: true, data: true } })
  expect(rows).toHaveLength(1)
  expect(rows[0].kind).toBe("report_actioned")
  expect(rows[0].title.length).toBeLessThanOrEqual(30)
  expect(JSON.stringify(rows[0])).not.toContain(reported)

  expect(sentMessages).toHaveLength(1)
  expect(sentMessages[0].data.type).toBe("report_actioned")
  expect(sentMessages[0].channelId).toBe("default")
  // Nobody else is told: not the person who was reported.
  expect(await db.notifications.count({ where: { user_id: reported } })).toBe(0)
})

it("a dismissal sends nothing, and neither does reinstating the account afterwards", async () => {
  const dismissed = await filed()
  await resolveReport("user", dismissed.report.id, "dismiss")
  expect(await db.notifications.count({ where: { user_id: dismissed.reporter } })).toBe(0)
  expect(sentMessages).toHaveLength(0)

  const upheld = await filed()
  await resolveReport("user", upheld.report.id, "suspend")
  sentMessages.length = 0
  await resolveReport("user", upheld.report.id, "reinstate")
  // The one line from the suspend, none from the reinstate.
  expect(await db.notifications.count({ where: { user_id: upheld.reporter } })).toBe(1)
  expect(sentMessages).toHaveLength(0)
})

describe("the other report kinds tell the person who filed them", () => {
  it("a message report, upheld: the reporter is told, and the author who was suspended is not", async () => {
    const reporter = await makeUser(testId("ra_m_reporter"))
    const author = await makeUser(testId("ra_m_author"))
    users.push(reporter, author)
    const [user1_id, user2_id] = [reporter, author].sort()
    const convo = await db.private_conversations.create({ data: { user1_id, user2_id } })
    const message = await db.private_messages.create({ data: { conversation_id: convo.id, sender_id: author, message_text: "rude" } })
    const report = await db.message_reports.create({ data: { reporter_id: reporter, message_id: message.id, message_type: "private", reason: "harassment" } })

    await resolveReport("message", report.id, "suspend")

    expect((await db.notifications.findMany({ where: { user_id: reporter } })).map((n) => n.kind)).toEqual(["report_actioned"])
    expect(await db.notifications.count({ where: { user_id: author } })).toBe(0)
    expect((await db.user.findUniqueOrThrow({ where: { id: author } })).suspended_at).not.toBeNull()
    await db.private_messages.deleteMany({ where: { conversation_id: convo.id } })
    await db.private_conversations.delete({ where: { id: convo.id } })
  })

  it("an event report, delisted: the person who filed it is told (event reports keep them in user_id, not reporter_id)", async () => {
    const host = await makeUser(testId("ra_e_host"))
    const reporter = await makeUser(testId("ra_e_reporter"))
    users.push(host, reporter)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const report = await db.event_reports.create({ data: { event_id: eventId, user_id: reporter, reason: "spam" } })

    await resolveReport("event", report.id, "delist")

    expect((await db.notifications.findMany({ where: { user_id: reporter } })).map((n) => n.kind)).toEqual(["report_actioned"])
    expect(await db.notifications.count({ where: { user_id: host } })).toBe(0)
    expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).visibility).toBe("unlisted")
  })

  it("a message report that is dismissed tells nobody", async () => {
    const reporter = await makeUser(testId("ra_d_reporter"))
    users.push(reporter)
    const report = await db.message_reports.create({ data: { reporter_id: reporter, message_id: randomUUID(), message_type: "private", reason: "spam" } })
    await resolveReport("message", report.id, "dismiss")
    expect(await db.notifications.count({ where: { user_id: reporter } })).toBe(0)
  })
})

describe("a push that fails cannot fail the decision", () => {
  it("when telling the reporter throws, the report is still resolved, the account suspended, the audit row written", async () => {
    const { reporter, reported, report } = await filed()
    const spy = jest.spyOn(push, "notifyReportActioned").mockRejectedValueOnce(new Error("push pipeline down"))

    await expect(resolveReport("user", report.id, "suspend")).resolves.toBeUndefined()

    expect(spy).toHaveBeenCalledWith(reporter)
    spy.mockRestore()
    expect((await db.user_reports.findUniqueOrThrow({ where: { id: report.id } })).status).toBe("resolved")
    expect((await db.user.findUniqueOrThrow({ where: { id: reported } })).suspended_at).not.toBeNull()
    expect(await db.audit_logs.count({ where: { resource_id: report.id, action: "report.suspend" } })).toBe(1)
  })
})
