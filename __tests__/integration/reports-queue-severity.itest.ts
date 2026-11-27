/**
 * The staff reports queue against the real database (SCRUM-1176): a message
 * report shows the words kept when it was filed, also once the message row is
 * gone, and the queue is taken S1 first, oldest first inside each, by the
 * query itself, so a page of the oldest reports cannot push a newer threat out.
 */
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { randomUUID } from "crypto"
import { getReportQueue } from "@/app/dashboard/moderation/reports/actions"
import { cleanup, closeDb, db, makeUser } from "./helpers"

const HOUR = 60 * 60 * 1000
const users: string[] = []
let reporter = ""

beforeAll(async () => {
  const admin = await makeUser("rq_admin", "app_admin")
  reporter = await makeUser("rq_reporter")
  users.push(admin, reporter)
  session = { user: { id: admin, role: "app_admin" } }
})

afterAll(async () => {
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

/** A pending report on a room message whose row no longer exists. */
const report = (reason: string, hoursAgo: number, excerpt: string | null = null) =>
  db.message_reports.create({
    data: {
      reporter_id: reporter,
      message_id: randomUUID(),
      message_type: "group",
      reason,
      excerpt,
      created_at: new Date(Date.now() - hoursAgo * HOUR),
    },
  })

it("shows the words kept at report time once the reported message is gone", async () => {
  const r = await report("harassment", 1, "come outside, alone")

  const row = (await getReportQueue()).rows.find((x) => x.id === r.id)

  expect(row?.excerpt).toBe("come outside, alone")
  expect(row?.gone).toBe(true)
})

it("puts a threat before harassment before spam, whatever their age", async () => {
  const spam = await report("spam", 30)
  const harassment = await report("harassment", 20)
  const threat = await report(" Threat ", 10)

  const mine = new Set([spam.id, harassment.id, threat.id])
  const order = (await getReportQueue()).rows.filter((x) => mine.has(x.id)).map((x) => x.id)

  expect(order).toEqual([threat.id, harassment.id, spam.id])
})

it("keeps a new threat on the page when a full page of older spam is waiting", async () => {
  await db.message_reports.createMany({
    data: Array.from({ length: 100 }, (_, i) => ({
      reporter_id: reporter,
      message_id: randomUUID(),
      message_type: "group",
      reason: "spam",
      created_at: new Date(Date.now() - (200 + i) * HOUR),
    })),
  })
  const threat = await report(" Threat ", 0)

  const { rows } = await getReportQueue()

  expect(rows.some((x) => x.id === threat.id)).toBe(true)
})
