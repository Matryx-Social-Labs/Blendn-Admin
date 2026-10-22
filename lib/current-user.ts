import type { user_role } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
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
    select: { role: true, suspended_at: true, deletedAt: true, password_changed_at: true, sessions_revoked_at: true },
  })
  if (!account || isRevoked({ sub: id, signedInAt: session.user.signedInAt }, account)) return null
  return { id, role: account.role }
}

/**
 * A platform admin, on the role the database holds now, or a `Refusal`.
 *
 * Every admin-only server action gates on this, never on
 * `session.user.role`: an action is a POST endpoint, and the claim in the
 * cookie is only as fresh as whatever built the session. A demoted, suspended
 * or deleted admin is refused on their next click, not at their next sign-in.
 * Defined once, here, so there is one rule rather than a copy per file that
 * can drift back to the claim — six files kept their own. This module is not
 * `"use server"`, so it may export it; the actions import it and never
 * re-export it. `__tests__/admin-gate-reads-database.test.ts` holds them to
 * that.
 */
export async function requireAdmin(): Promise<{ id: string; role: user_role }> {
  const user = await currentUser()
  if (!user || user.role !== "app_admin") throw new Refusal("Forbidden")
  return user
}
