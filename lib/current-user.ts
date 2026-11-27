import type { user_role } from "@prisma/client"

import { getAuth, getInviteAuth } from "@/lib/auth"
import { sessionAccount } from "@/lib/org-membership"
import { Refusal } from "@/lib/refusal"
import { isRevoked } from "@/lib/session-revocation"

/**
 * The signed-in dashboard user with the role the database holds now — for
 * anything that authorises, which must not trust a claim carried in the
 * session cookie (review LOW 18).
 *
 * `getAuth()` has already run the jwt callback's check; this runs the same
 * rule (`isRevoked`, lib/session-revocation.ts) again on its own read, so a
 * session object built anywhere else, or a change to that callback, cannot
 * hand out a person the database has ended: deleted, suspended, or signed in
 * before the password changed. The role is the one the session's claim carries,
 * derived from the same read (`dashboardRoleFor`: `app_admin` from the row,
 * anyone else from their memberships, SCRUM-1247), so a page and its action
 * cannot disagree; the session lends only its id and when it signed in. A read that fails throws — never a user made
 * from the session's claims.
 */
async function accountOf(session: Awaited<ReturnType<typeof getInviteAuth>>): Promise<{ id: string; role: user_role } | null> {
  const id = session?.user?.id
  if (!id) return null
  const account = await sessionAccount(id)
  if (!account || isRevoked({ sub: id, signedInAt: session?.user?.signedInAt }, account)) return null
  return { id, role: account.dashboardRole }
}

export async function currentUser(): Promise<{ id: string; role: user_role } | null> {
  return accountOf(await getAuth())
}

/** `currentUser` for the accept route alone: a session held only to accept an invite counts here (SCRUM-984). */
export async function invitedUser(): Promise<{ id: string; role: user_role } | null> {
  return accountOf(await getInviteAuth())
}

export async function requireAdmin(): Promise<{ id: string; role: user_role }> {
  const user = await currentUser()
  if (!user || user.role !== "app_admin") throw new Refusal("Forbidden")
  return user
}
