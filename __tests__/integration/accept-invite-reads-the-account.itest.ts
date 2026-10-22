/**
 * Accepting an invitation answers to the account, not the session's claims
 * (step 18 security review, L4).
 *
 * The route bound the invite to `session.user.email` and promoted on
 * `session.user.role` — both minted at sign-in. An address changed since then
 * still opened an invite sent to the old one, and a role claim decided a
 * promotion the database did not agree with. It reads the person through
 * `currentUser()` now, and their address from the row.
 */
let mockSession: unknown = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(mockSession) }))

import { NextRequest } from "next/server"

import { POST } from "@/app/api/organisation/accept-invite/route"
import { hashInviteToken } from "@/lib/org-invites"
import { resetMemoryStore } from "@/lib/rate-limit-store"

import { closeDb, db, makeUser, testId } from "./helpers"

const orgs: string[] = []
const users: string[] = []

afterAll(async () => {
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => resetMemoryStore())

async function invitedTo(email: string) {
  const owner = await makeUser("l4_owner", "organizer")
  users.push(owner)
  const org = await db.organisations.create({ data: { display_name: `L4 ${testId("o")}`, kind: "company" } })
  orgs.push(org.id)
  const token = testId("tok")
  await db.organisation_invites.create({
    data: { org_id: org.id, email, token_hash: hashInviteToken(token), expires_at: new Date(Date.now() + 86_400_000), invited_by: owner },
  })
  return { org: org.id, token }
}

async function person(email: string) {
  const id = await makeUser("l4_person", "organizer")
  users.push(id)
  await db.user.update({ where: { id }, data: { email } })
  return id
}

const accept = (token: string) =>
  POST(
    new NextRequest("http://localhost/api/organisation/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.44" },
      body: JSON.stringify({ token }),
    })
  )

it("binds the invite to the address the account holds now, not the one the session was minted with", async () => {
  const invited = `l4-old-${testId("x").toLowerCase()}@toit.in`
  const { org, token } = await invitedTo(invited)
  const id = await person(`l4-new-${testId("x").toLowerCase()}@toit.in`)
  mockSession = { user: { id, role: "organizer", email: invited, signedInAt: Date.now() } }

  const res = await accept(token)
  expect(res.status).toBe(400)
  expect(await db.organisation_members.count({ where: { org_id: org, user_id: id } })).toBe(0)
})

it("lets the holder of the invited address in, at the invited role", async () => {
  const invited = `l4-${testId("x").toLowerCase()}@toit.in`
  const { org, token } = await invitedTo(invited)
  const id = await person(invited)
  mockSession = { user: { id, role: "organizer", email: invited, signedInAt: Date.now() } }

  expect((await accept(token)).status).toBe(200)
  expect(await db.organisation_members.findFirst({ where: { org_id: org, user_id: id }, select: { role: true } })).toEqual({ role: "staff" })
})

it("refuses a session the database has ended", async () => {
  const invited = `l4-gone-${testId("x").toLowerCase()}@toit.in`
  const { org, token } = await invitedTo(invited)
  const id = await person(invited)
  await db.user.update({ where: { id }, data: { suspended_at: new Date() } })
  mockSession = { user: { id, role: "organizer", email: invited, signedInAt: Date.now() } }

  expect((await accept(token)).status).toBe(401)
  expect(await db.organisation_members.count({ where: { org_id: org, user_id: id } })).toBe(0)
})

it("promotes on the role the database holds, not the claim", async () => {
  const invited = `l4-claim-${testId("x").toLowerCase()}@toit.in`
  const { token } = await invitedTo(invited)
  const id = await person(invited)
  await db.user.update({ where: { id }, data: { role: "venue_owner" } })
  mockSession = { user: { id, role: "attendee", email: invited, signedInAt: Date.now() } }

  const res = await accept(token)
  expect(res.status).toBe(200)
  expect((await res.json()).roleChanged).toBe(false)
  expect((await db.user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role).toBe("venue_owner")
})
