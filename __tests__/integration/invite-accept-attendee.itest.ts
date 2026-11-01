/*
 * An attendee an organisation invited can accept, and comes out as what the inviter is (SCRUM-984).
 *
 * The role decides what the dashboard opens: `organizer` creates events, so a sponsor's or a venue owner's invite must not
 * hand it out. It is fixed when the invite is sent, and the invite ends with the sender's standing.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: unknown = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session), getInviteAuth: () => Promise.resolve(session) }))

import { NextRequest } from "next/server"

import { hashInviteToken } from "@/lib/org-invites"
import { closeDb, cleanup, db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const accept = require("@/app/api/organisation/accept-invite/route") as typeof import("@/app/api/organisation/accept-invite/route")
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

async function invitedBy(role: "organizer" | "venue_owner" | "sponsor", grants: typeof role | null = role, invitedAs: "staff" | "owner" = "staff") {
  const inviter = await makeUser(testId("inv-from"))
  await db.user.update({ where: { id: inviter }, data: { role } })
  const attendee = await makeUser(testId("inv-to"))
  users.push(inviter, attendee)
  const org = await db.organisations.create({ data: { display_name: testId("inv-org"), kind: "company", status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: inviter, role: "owner" } })
  const token = testId("tok")
  const email = (await db.user.findUniqueOrThrow({ where: { id: attendee }, select: { email: true } })).email!.toLowerCase()
  await db.user.update({ where: { id: attendee }, data: { email } })
  await db.organisation_invites.create({
    data: {
      org_id: org.id,
      email,
      role: invitedAs,
      token_hash: hashInviteToken(token),
      expires_at: new Date(Date.now() + 86_400_000),
      invited_by: inviter,
      grants_role: grants,
    },
  })
  session = { user: { id: attendee, role: "attendee", email, signedInAt: Date.now(), inviteOnly: true } }
  return { attendee, inviter, org: org.id, token }
}

const post = (token: string) =>
  accept.POST(new NextRequest("http://localhost/api/organisation/accept-invite", { method: "POST", body: JSON.stringify({ token }) }))

const standing = async (attendee: string, org: string) => ({
  role: (await db.user.findUniqueOrThrow({ where: { id: attendee }, select: { role: true } })).role,
  members: await db.organisation_members.count({ where: { org_id: org, user_id: attendee } }),
})

describe("accepting an invite as an attendee", () => {
  it.each(["organizer", "venue_owner", "sponsor"] as const)("comes out %s when the invite says so, a member of the org", async (role) => {
    const { attendee, org, token } = await invitedBy(role)
    expect((await post(token)).status).toBe(200)
    expect(await standing(attendee, org)).toEqual({ role, members: 1 })
  })

  it("the role is the invite's, not the sender's today", async () => {
    const { attendee, org, token, inviter } = await invitedBy("venue_owner")
    await db.user.update({ where: { id: inviter }, data: { role: "organizer" } })
    expect((await post(token)).status).toBe(200)
    expect(await standing(attendee, org)).toEqual({ role: "venue_owner", members: 1 })
  })
})

describe("an invite fails closed, and nobody is promoted", () => {
  it("from before the column: no role on the row", async () => {
    const { attendee, org, token } = await invitedBy("organizer", null)
    expect((await post(token)).status).toBe(400)
    expect(await standing(attendee, org)).toEqual({ role: "attendee", members: 0 })
  })

  it.each([
    ["removed from the org", (id: string, org: string) => db.organisation_members.deleteMany({ where: { org_id: org, user_id: id } })],
    ["suspended", (id: string) => db.user.update({ where: { id }, data: { suspended_at: new Date() } })],
    ["deleted", (id: string) => db.user.update({ where: { id }, data: { deletedAt: new Date() } })],
    ["demoted to attendee", (id: string) => db.user.update({ where: { id }, data: { role: "attendee" } })],
    ["demoted to staff in the org", (id: string, org: string) => db.organisation_members.update({ where: { org_id_user_id: { org_id: org, user_id: id } }, data: { role: "staff" } })],
  ])("when the sender was %s", async (_label, change) => {
    const { attendee, inviter, org, token } = await invitedBy("organizer")
    await change(inviter, org)
    expect((await post(token)).status).toBe(400)
    expect(await standing(attendee, org)).toEqual({ role: "attendee", members: 0 })
  })

  it("an owner's invite from an owner who is now an admin of the org", async () => {
    const { attendee, inviter, org, token } = await invitedBy("organizer", "organizer", "owner")
    await db.organisation_members.update({ where: { org_id_user_id: { org_id: org, user_id: inviter } }, data: { role: "admin" } })
    expect((await post(token)).status).toBe(400)
    expect(await standing(attendee, org)).toEqual({ role: "attendee", members: 0 })
  })
})

describe("the sender who still stands", () => {
  it("an admin of the org keeps a staff invite good, and an app_admin needs no membership", async () => {
    const a = await invitedBy("organizer")
    await db.organisation_members.update({ where: { org_id_user_id: { org_id: a.org, user_id: a.inviter } }, data: { role: "admin" } })
    expect((await post(a.token)).status).toBe(200)

    const b = await invitedBy("organizer")
    await db.user.update({ where: { id: b.inviter }, data: { role: "app_admin" } })
    await db.organisation_members.deleteMany({ where: { org_id: b.org, user_id: b.inviter } })
    expect((await post(b.token)).status).toBe(200)
    expect(await standing(b.attendee, b.org)).toEqual({ role: "organizer", members: 1 })
    const audit = await db.audit_logs.findFirst({ where: { user_id: b.attendee, action: "org.invite.accepted" }, select: { details: true } })
    expect(audit?.details).toMatchObject({ dashboardRole: "organizer", invitedBy: b.inviter })
  })
})
