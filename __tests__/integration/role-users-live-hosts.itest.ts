/*
 * The host lists are of live hosts (SCRUM-310).
 *
 * Driven on staging: /dashboard/organisers said "9 never published", and 5 of
 * the 9 were suspended accounts — retired test accounts and a suspended
 * outsider — listed exactly like a live host. `getRoleUsers` selected neither
 * `suspended_at` nor `deletedAt`, so a deleted account keeping its role would
 * have been listed too. Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { neverPublished } from "@/lib/dashboard-format"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getRoleUsers } = require("@/lib/admin-role-actions") as typeof import("@/lib/admin-role-actions")

const users: string[] = []
afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

it("marks a suspended organiser, leaves out a deleted one, and counts only live ones as never published", async () => {
  const admin = await makeUser(testId("rul-admin"), "app_admin")
  const live = await makeUser(testId("rul-live"), "organizer")
  const suspended = await makeUser(testId("rul-suspended"), "organizer")
  const deleted = await makeUser(testId("rul-deleted"), "organizer")
  users.push(admin, live, suspended, deleted)
  await db.user.update({ where: { id: suspended }, data: { suspended_at: new Date() } })
  await db.user.update({ where: { id: deleted }, data: { deletedAt: new Date() } })
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })

  const list = await getRoleUsers("organizer")
  const mine = list.filter((u) => [live, suspended, deleted].includes(u.id))

  expect(mine.map((u) => u.id).sort()).toEqual([live, suspended].sort())
  expect(mine.find((u) => u.id === suspended)?.suspended).toBe(true)
  expect(mine.find((u) => u.id === live)?.suspended).toBe(false)
  expect(neverPublished(mine)).toBe(1)
})
