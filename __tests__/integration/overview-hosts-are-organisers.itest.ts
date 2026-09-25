/*
 * Hosts are organisers (SCRUM-314, the owner's ruling).
 *
 * The admin's own events are the ones the team curates and seeds before
 * organisers are onboarded; they are not host supply. On staging the Overview
 * counted an app_admin's two events as a publishing host ("4 of 14", busiest
 * host 86%) while /dashboard/organisers said 92%, and divided by every
 * organiser and venue-owner account, suspended ones included. Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDashboardOverview } = require("@/app/dashboard/actions") as typeof import("@/app/dashboard/actions")

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await cleanup(users, events)
  await closeDb()
})

async function overview() {
  const o = await getDashboardOverview()
  if (o.role !== "app_admin") throw new Error("wrong overview role")
  return o
}

it("counts organisers as hosts — not an admin's own events, not a suspended account", async () => {
  const admin = await makeUser(testId("oho-admin"), "app_admin")
  users.push(admin)
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })
  const before = await overview()

  const organiser = await makeUser(testId("oho-organiser"), "organizer")
  const suspended = await makeUser(testId("oho-suspended"), "organizer")
  users.push(organiser, suspended)
  await db.user.update({ where: { id: suspended }, data: { suspended_at: new Date() } })
  events.push(await makeEvent(organiser), await makeEvent(admin))

  const after = await overview()
  expect(after.publishingHosts.publishing - before.publishingHosts.publishing).toBe(1)
  expect(after.publishingHosts.total - before.publishingHosts.total).toBe(1)
  expect(after.supply.map((r) => r.id)).toContain(organiser)
  expect(after.supply.map((r) => r.id)).not.toContain(admin)
})
