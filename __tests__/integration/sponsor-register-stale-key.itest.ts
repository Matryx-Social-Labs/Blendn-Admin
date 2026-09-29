const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { normaliseSponsorName } from "@/lib/sponsor-name"
import { getSponsorRegister } from "@/lib/sponsor-actions"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * The admin brand register shows two rows for one brand as a duplicate, however
 * their stored keys were written (SCRUM-456).
 *
 * On staging sponsor@'s organisation had "Blue Tokai" twice: one keyed
 * `bluetokai` by the product, one `blue tokai` by a seed. The register grouped
 * on the stored `name_key`, said "every name is distinct", and so offered no
 * merge, the only way an admin can repair it.
 */
const users: string[] = []
const brands: string[] = []

afterAll(async () => {
  await db.sponsors.deleteMany({ where: { id: { in: brands } } })
  await cleanup(users, [])
  await closeDb()
})

it("clusters two brands whose stored keys disagree about the same name", async () => {
  const admin = await makeUser(testId("reg-admin"), "app_admin")
  users.push(admin)
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })
  const name = `Blue Tokai ${testId("r")}`
  for (const name_key of [normaliseSponsorName(name), name.toLowerCase()]) {
    const row = await db.sponsors.create({ data: { name, name_key, created_by: admin } })
    brands.push(row.id)
  }

  const register = await getSponsorRegister()

  const cluster = register.duplicates.find((c) => c.some((r) => brands.includes(r.id)))
  expect(cluster?.map((r) => r.id).sort()).toEqual([...brands].sort())
  expect(register.rest.some((r) => brands.includes(r.id))).toBe(false)
})
