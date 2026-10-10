import type { org_role } from "@prisma/client"

/**
 * An organisation role in words, for every screen that names one: the Team
 * page's members and invites, and the invite a colleague accepts. Pure, so a
 * client page may import it.
 */
export const ROLE_LABEL: Record<org_role, string> = {
  owner: "Owner",
  admin: "Admin",
  staff: "Staff",
}

export const ROLE_BLURB: Record<org_role, string> = {
  owner: "Everything, including domains and removing the organisation.",
  admin: "Members and events. Cannot verify domains.",
  staff: "Events and chat. Cannot change who is in the organisation.",
}
