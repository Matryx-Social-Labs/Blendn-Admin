import type { user_role } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
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
 * before the password changed. The role is the row's; the session lends only
 * its id and when it signed in. A read that fails throws — never a user made
 * from the session's claims.
 */
export async function currentUser(): Promise<{ id: string; role: user_role } | null> {
  const session = await getAuth()
  const id = session?.user?.id
  if (!id) return null
  const account = await db.user.findUnique({
    where: { id },
    select: { role: true, suspended_at: true, deletedAt: true, password_changed_at: true },
  })
  if (!account || isRevoked({ sub: id, signedInAt: session.user.signedInAt }, account)) return null
  return { id, role: account.role }
}
