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

import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

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

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: admin } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
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
