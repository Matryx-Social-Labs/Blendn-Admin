/**
 * An organisation's own actions cannot reach another organisation by sending an
 * object where an id belongs (Aikido AIK_ts_node_nosqli_injection on
 * lib/org-actions.ts). The unit twin, `__tests__/org-actions-object-ids.test.ts`,
 * asserts nothing is asked; this one shows against Postgres what used to happen.
 *
 * A server action's arguments are whatever the client posts, and Prisma reads
 * `{ in: [mine, theirs] }` as a filter: the caller's membership of their own org
 * satisfied `requireOrgRole`, and the action's `org_id: orgId` then took in the
 * other organisation too.
 */
let mockSession: unknown = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(mockSession) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getOrgMembers, removeDomain, revokeInvite } from "@/lib/org-actions"

import { closeDb, db, makeUser, testId } from "./helpers"

const orgs: string[] = []
const users: string[] = []

afterAll(async () => {
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

/** An owner of their own org, and somebody else's org with a domain, an invite and a member. */
async function twoOrgs() {
  const attacker = await makeUser("objid_attacker", "organizer")
  const victimOwner = await makeUser("objid_victim", "organizer")
  users.push(attacker, victimOwner)
  const mine = await db.organisations.create({ data: { display_name: testId("Mine"), kind: "company", status: "verified" } })
  const theirs = await db.organisations.create({ data: { display_name: testId("Theirs"), kind: "company", status: "verified" } })
  orgs.push(mine.id, theirs.id)
  await db.organisation_members.create({ data: { org_id: mine.id, user_id: attacker, role: "owner" } })
  await db.organisation_members.create({ data: { org_id: theirs.id, user_id: victimOwner, role: "owner" } })
  const domain = await db.organisation_domains.create({
    data: { org_id: theirs.id, domain: `${testId("d").toLowerCase()}.example`, verification_token: testId("t") },
  })
  const invite = await db.organisation_invites.create({
    data: {
      org_id: theirs.id,
      email: `${testId("i").toLowerCase()}@theirs.example`,
      token_hash: testId("h"),
      expires_at: new Date(Date.now() + 86_400_000),
      invited_by: victimOwner,
    },
  })
  mockSession = { user: { id: attacker, role: "organizer", signedInAt: Date.now() } }
  const both = { in: [mine.id, theirs.id] } as unknown as string
  return { theirs: theirs.id, domain: domain.id, invite: invite.id, both, victimOwner }
}

it("removeDomain does not delete another organisation's domain", async () => {
  const { domain, both } = await twoOrgs()
  await removeDomain(both, { in: [domain] } as unknown as string).catch(() => undefined)
  expect(await db.organisation_domains.count({ where: { id: domain } })).toBe(1)
})

it("revokeInvite does not revoke another organisation's invite", async () => {
  const { invite, both } = await twoOrgs()
  await revokeInvite(both, { in: [invite] } as unknown as string).catch(() => undefined)
  const row = await db.organisation_invites.findUniqueOrThrow({ where: { id: invite }, select: { revoked_at: true } })
  expect(row.revoked_at).toBeNull()
})

it("getOrgMembers does not list another organisation's people", async () => {
  const { both, victimOwner } = await twoOrgs()
  const listed = await getOrgMembers(both).catch(() => null)
  expect(listed?.members.map((m) => m.userId) ?? []).not.toContain(victimOwner)
})
