/*
 * An attendee an organisation invited can accept, and comes out as what the inviter is (SCRUM-984).
 *
 * The role decides what the dashboard opens: `organizer` creates events, so a sponsor's or a venue owner's invite must not
 * hand it out. A session held only for the invite reaches no join-request route.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: unknown = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

import { NextRequest } from "next/server"

import { hashInviteToken } from "@/lib/org-invites"
import { closeDb, cleanup, db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const accept = require("@/app/api/organisation/accept-invite/route") as typeof import("@/app/api/organisation/accept-invite/route")
const join = require("@/app/api/organisation/join-request/route") as typeof import("@/app/api/organisation/join-request/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await db.organisation_invites.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function invitedBy(role: "organizer" | "venue_owner" | "sponsor") {
  const inviter = await makeUser(testId("inv-from"))
  await db.user.update({ where: { id: inviter }, data: { role } })
  const attendee = await makeUser(testId("inv-to"))
  users.push(inviter, attendee)
  const org = await db.organisations.create({ data: { display_name: testId("inv-org"), kind: "company", status: "verified" } })
  orgs.push(org.id)
  const token = testId("tok")
  await db.organisation_invites.create({
    data: {
      org_id: org.id,
      email: `${attendee}@itest.invalid`.toLowerCase(),
      role: "staff",
      token_hash: hashInviteToken(token),
      expires_at: new Date(Date.now() + 86_400_000),
      invited_by: inviter,
    },
  })
  return { attendee, org: org.id, token }
}

const post = (token: string) =>
  accept.POST(new NextRequest("http://localhost/api/organisation/accept-invite", { method: "POST", body: JSON.stringify({ token }) }))

describe("accepting an invite as an attendee", () => {
  it.each(["organizer", "venue_owner", "sponsor"] as const)("comes out %s when a %s invited them, a member of the org", async (role) => {
    const { attendee, org, token } = await invitedBy(role)
    await db.user.update({ where: { id: attendee }, data: { email: `${attendee}@itest.invalid`.toLowerCase() } })
    session = { user: { id: attendee, role: "attendee", email: `${attendee}@itest.invalid`.toLowerCase(), signedInAt: Date.now() } }

    const res = await post(token)

    expect(res.status).toBe(200)
    expect((await db.user.findUniqueOrThrow({ where: { id: attendee }, select: { role: true } })).role).toBe(role)
    expect(await db.organisation_members.count({ where: { org_id: org, user_id: attendee } })).toBe(1)
  })
})

describe("a session held only for the invite", () => {
  it("lists and queues no join request", async () => {
    const attendee = await makeUser(testId("inv-only"))
    users.push(attendee)
    session = { user: { id: attendee, role: "attendee", email: "someone@acme.example" } }

    expect(await (await join.GET()).json()).toEqual({ matches: [], domain: null })
    const res = await join.POST(new NextRequest("http://localhost/api/organisation/join-request", { method: "POST", body: JSON.stringify({ orgId: "00000000-0000-4000-8000-000000000000" }) }))
    expect(res.status).toBe(403)
  })
})
