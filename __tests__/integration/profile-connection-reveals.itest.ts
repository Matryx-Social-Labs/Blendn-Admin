import { NextRequest } from "next/server"

/*
 * A profile's `connection` says who has revealed in your match, so the app's
 * one-sided copy is right ("They revealed. Reveal back?"). The flags are the
 * thread's own (`GET /conversations/:id`), and `connection` is still sent only
 * to a viewer who may already see who this is: the side that has not been
 * revealed to gets no `connection` at all, so nothing ties the pseudonym to
 * the person. Real route, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")

const users: string[] = []
afterAll(async () => {
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, [])
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.upsert({ where: { id }, create: { id, name: `Person ${label}`, onboarded: true }, update: {} })
  return id
}

async function card(viewer: string, subject: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: viewer }, select: { email: true } })
  const res = await userRoute.GET(
    new NextRequest(`http://localhost/api/mobile/users/${subject}`, { headers: { authorization: `Bearer ${signAccessToken(viewer, email)}` } }),
    { params: Promise.resolve({ userId: subject }) }
  )
  expect(res.status).toBe(200)
  return (await res.json()).data as { identityVisible: boolean; connection?: Record<string, unknown> }
}

it("one-sided: the side revealed to is told who revealed; the other side gets no connection; both revealed reads both", async () => {
  const ana = await person("pcr-ana")
  const ben = await person("pcr-ben")
  const [user1_id, user2_id] = conversationPair(ana, ben)
  const anaIs1 = user1_id === ana
  const convo = await db.private_conversations.create({
    data: {
      user1_id,
      user2_id,
      user1_pseudonym: "Quiet Otter",
      user2_pseudonym: "Amber Fox",
      // Ben has revealed; Ana has not.
      user1_revealed: !anaIs1,
      user2_revealed: anaIs1,
    },
  })

  const anaSees = await card(ana, ben)
  expect(anaSees.identityVisible).toBe(true)
  expect(anaSees.connection).toEqual({ conversationId: convo.id, request: null, youRevealed: false, theyRevealed: true })

  // Ben may not see who Ana is: no connection, so no conversation id beside a pseudonym.
  const benSees = await card(ben, ana)
  expect(benSees.identityVisible).toBe(false)
  expect(benSees).not.toHaveProperty("connection")

  await db.private_conversations.update({ where: { id: convo.id }, data: { user1_revealed: true, user2_revealed: true } })
  expect((await card(ben, ana)).connection).toMatchObject({ youRevealed: true, theyRevealed: true })
})
