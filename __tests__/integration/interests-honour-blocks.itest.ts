import { NextRequest } from "next/server"

/*
 * A block reaches a person's interests (SCRUM-299).
 *
 * Driven on staging: ananya blocked rohan, and rohan got 404 on her profile
 * and on her card but 200 on `GET /profiles/{ananya}/interests`, with every
 * interest's name and the date she added it. Two of the three reads of a
 * profile consulted `blockedEitherWay`; this one never did. Real route, real
 * rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { closeDb, cleanup, db, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const interests = require("@/app/api/mobile/profiles/[userId]/interests/route") as typeof import("@/app/api/mobile/profiles/[userId]/interests/route")

const users: string[] = []
let categoryId = ""
const INTEREST = "Exhibitions"

beforeAll(async () => {
  const slug = testId("ihb-category")
  categoryId = (await db.categories.create({ data: { name: INTEREST, slug }, select: { id: true } })).id
})

afterAll(async () => {
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  if (categoryId) await db.categories.delete({ where: { id: categoryId } })
  await closeDb()
})

async function personWithInterest(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.user_interests.create({ data: { user_id: id, category_id: categoryId } })
  return id
}

async function readInterests(ownerId: string, asUserId: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: asUserId }, select: { email: true } })
  const res = await interests.GET(
    new NextRequest(`http://localhost/api/mobile/profiles/${ownerId}/interests`, {
      headers: { authorization: `Bearer ${signAccessToken(asUserId, email)}` },
    }),
    { params: Promise.resolve({ userId: ownerId }) }
  )
  return { status: res.status, body: await res.json() }
}

it("answers the person you blocked with 404, and nothing about your interests", async () => {
  const owner = await personWithInterest("ihb-owner")
  const blocked = await personWithInterest("ihb-blocked")
  await db.blocked_users.create({ data: { blocker_id: owner, blocked_id: blocked } })

  const r = await readInterests(owner, blocked)
  expect(r.status).toBe(404)
  expect(r.body.data).toBeUndefined()
  expect(JSON.stringify(r.body)).not.toContain(INTEREST)
})

it("works both ways: the person who blocked you cannot read yours either", async () => {
  const blocker = await personWithInterest("ihb-blocker")
  const target = await personWithInterest("ihb-target")
  await db.blocked_users.create({ data: { blocker_id: blocker, blocked_id: target } })

  expect((await readInterests(target, blocker)).status).toBe(404)
})

it("still serves a stranger with no block, and the owner their own list", async () => {
  const owner = await personWithInterest("ihb-open")
  const stranger = await personWithInterest("ihb-stranger")

  const asStranger = await readInterests(owner, stranger)
  expect(asStranger.status).toBe(200)
  expect(asStranger.body.data.interests.map((i: { name: string }) => i.name)).toEqual([INTEREST])

  // A block elsewhere does not stop you reading yourself.
  const other = await personWithInterest("ihb-other")
  await db.blocked_users.create({ data: { blocker_id: owner, blocked_id: other } })
  expect((await readInterests(owner, owner)).status).toBe(200)
})
