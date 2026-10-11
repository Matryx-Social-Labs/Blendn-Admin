import type { user_role } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { Refusal } from "@/lib/refusal"

/**
 * The signed-in dashboard user with the role the database holds now — for
 * the money actions, which must not authorise on a claim carried in the
 * session cookie (review LOW 18). `lib/auth.ts` refreshes that claim per
 * request today; this reads the row itself, so a change there, or a session
 * object built anywhere else, cannot hand out a role the database does not
 * hold. A deleted or suspended user is nobody.
 */
export async function currentUser(): Promise<{ id: string; role: user_role } | null> {
  const id = (await getAuth())?.user?.id
  if (!id) return null
  const row = await db.user.findUnique({ where: { id }, select: { role: true, suspended_at: true, deletedAt: true } })
  if (!row || row.deletedAt || row.suspended_at) return null
  return { id, role: row.role }
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
