import type { org_role } from "@prisma/client"

export type OrgRole = org_role

export interface OrgPermissions {
  /** Invite, remove, and change the role of other members. */
  canManageMembers: boolean
  /** Edit display name, legal name, GSTIN, address, website. */
  canEditOrg: boolean
  /** Add and verify a domain. */
  canVerifyDomain: boolean
  canDeleteOrg: boolean
}

const NONE: OrgPermissions = {
  canManageMembers: false,
  canEditOrg: false,
  canVerifyDomain: false,
  canDeleteOrg: false,
}

/**
 * What a member may do to the organisation itself.
 *
 * Separate from `eventPermissions` on purpose. Those answer different
 * questions — "may this person operate this event" versus "may this person
 * change who is in this company" — and the one time they were merged, the
 * result was two predicates that disagreed and a venue owner locked out of
 * every chatroom.
 *
 * Running events is deliberately absent: every member can operate events,
 * which is what "staff run events and chat" means, so that stays in
 * `eventPermissions` rather than being re-decided here.
 *
 * `canVerifyDomain` sits with the owner alone because verifying a domain is
 * what unlocks restricting invites to it — whoever controls the domain
 * controls who can be invited without an override.
 *
 * Pinned by __tests__/org-permissions.test.ts.
 */
export function orgPermissions(role: OrgRole): OrgPermissions {
  switch (role) {
    case "owner":
      return {
        canManageMembers: true,
        canEditOrg: true,
        canVerifyDomain: true,
        canDeleteOrg: true,
      }
    case "admin":
      return {
        canManageMembers: true,
        canEditOrg: true,
        canVerifyDomain: false,
        canDeleteOrg: false,
      }
    case "staff":
      return NONE
    default:
      // Unknown role fails closed rather than defaulting to the lowest real
      // tier — a role added to the enum and forgotten here gets nothing.
      return NONE
  }
}
