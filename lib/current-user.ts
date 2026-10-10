import type { user_role } from "@prisma/client"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"

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
