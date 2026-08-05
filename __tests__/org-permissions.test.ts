import { orgPermissions, type OrgRole } from "@/lib/org-permissions"

/**
 * Who may act on the organisation itself.
 *
 * Deliberately a separate resolver from `eventPermissions`. Merging "what may
 * this person do with an event" and "what may this person do to the company"
 * into one function is precisely how `canManageEvent` and `canModerateChat`
 * ended up contradicting each other and locking venue owners out of every
 * chatroom. Two questions, two resolvers.
 *
 * Note what is NOT here: running events. Every member can operate events —
 * that is what "staff run events and chat" means — so event access stays in
 * `eventPermissions` and is not re-decided per org role.
 */

const ROLES: OrgRole[] = ["owner", "admin", "staff"]

describe("orgPermissions", () => {
  it("gives the owner everything", () => {
    const p = orgPermissions("owner")
    expect(p.canManageMembers).toBe(true)
    expect(p.canEditOrg).toBe(true)
    expect(p.canVerifyDomain).toBe(true)
    expect(p.canDeleteOrg).toBe(true)
  })

  it("lets an admin manage members and org details, but not the domain or deletion", () => {
    // Domain verification is what unlocks restricting invites to that domain,
    // so whoever controls it controls who can be invited. That stays with the
    // owner. Deletion likewise — it is not recoverable.
    const p = orgPermissions("admin")
    expect(p.canManageMembers).toBe(true)
    expect(p.canEditOrg).toBe(true)
    expect(p.canVerifyDomain).toBe(false)
    expect(p.canDeleteOrg).toBe(false)
  })

  it("gives staff no org management at all", () => {
    // Staff run events and chat. If staff could invite, any compromised staff
    // account becomes a way to hand out access.
    const p = orgPermissions("staff")
    expect(p.canManageMembers).toBe(false)
    expect(p.canEditOrg).toBe(false)
    expect(p.canVerifyDomain).toBe(false)
    expect(p.canDeleteOrg).toBe(false)
  })

  it("fails closed on an unknown or missing role", () => {
    for (const bad of [undefined, null, "", "superuser"]) {
      const p = orgPermissions(bad as unknown as OrgRole)
      expect(Object.values(p).every((v) => v === false)).toBe(true)
    }
  })

  it("never lets a lower tier exceed a higher one", () => {
    // Guards a future edit that grants staff something admin lacks, which
    // would make the tiers meaningless.
    const [owner, admin, staff] = ROLES.map(orgPermissions)
    for (const key of Object.keys(owner) as Array<keyof typeof owner>) {
      if (admin[key]) expect(owner[key]).toBe(true)
      if (staff[key]) expect(admin[key]).toBe(true)
    }
  })

  it("makes deleting the org strictly the narrowest permission", () => {
    const holders = ROLES.filter((r) => orgPermissions(r).canDeleteOrg)
    expect(holders).toEqual(["owner"])
  })
})
