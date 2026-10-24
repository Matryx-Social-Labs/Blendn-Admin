import { NextRequest } from "next/server"

/*
 * An interest is a leaf, never a group heading (S-9).
 *
 * qa.rc.a on staging held "Arts & Culture" and "Business & Professional",
 * two parents, written by one POST on 2026-10-23, and Me and Profile showed
 * the headings as interests. The route checked only that a category existed.
 * A category with children is a heading; a childless one is its own option,
 * as the app's picker offers it. Real route, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { closeDb, cleanup, db, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const interests = require("@/app/api/mobile/profiles/[userId]/interests/route") as typeof import("@/app/api/mobile/profiles/[userId]/interests/route")

const users: string[] = []
const categories: string[] = []
let group = ""
let leaf = ""
let childless = ""

const category = async (name: string, parent_id?: string) => {
  const { id } = await db.categories.create({ data: { name, slug: testId("ilo"), ...(parent_id && { parent_id }) }, select: { id: true } })
  categories.push(id)
  return id
}

beforeAll(async () => {
  group = await category("Arts & Culture")
  leaf = await category("Exhibitions", group)
  childless = await category("Standalone")
})

afterAll(async () => {
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await db.categories.deleteMany({ where: { id: { in: [...categories].reverse() } } })
  await closeDb()
})

async function add(categoryIds: string[]) {
  const id = await makeUser(testId("ilo"))
  users.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  const res = await interests.POST(
    new NextRequest(`http://localhost/api/mobile/profiles/${id}/interests`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(id, email)}` },
      body: JSON.stringify({ categoryIds }),
    }),
    { params: Promise.resolve({ userId: id }) }
  )
  const held = await db.user_interests.findMany({ where: { user_id: id }, select: { category_id: true } })
  return { status: res.status, body: await res.json(), held: held.map((h) => h.category_id) }
}

it("refuses a group heading, alone or beside a leaf, and stores nothing", async () => {
  for (const ids of [[group], [leaf, group]]) {
    const r = await add(ids)
    expect(r.status).toBe(400)
    // The validation shape: VALIDATION_FAILED with the field's error, and the reason beside it.
    expect([r.body.errorCode, r.body.reasonCode]).toEqual(["VALIDATION_FAILED", "CATEGORY_IS_A_GROUP"])
    expect(r.body.errors).toEqual([{ field: "categoryIds", message: "Pick an interest inside a group, not the group itself." }])
    expect(r.held).toEqual([])
  }
})

it("stores a leaf, and a top-level category with no children (its own option)", async () => {
  const r = await add([leaf, childless])
  expect(r.status).toBe(200)
  expect(r.held.sort()).toEqual([leaf, childless].sort())
})
