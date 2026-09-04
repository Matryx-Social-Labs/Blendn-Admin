"use server"

import { revalidatePath } from "next/cache"

import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { actorFor } from "@/lib/org-membership"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"

/**
 * Somebody saw it.
 *
 * Distinct from resolved, which the sweep sets when the condition stops. An
 * alert that cleared itself and one a human acted on are different facts, and
 * the second is the one that gets asked about after the night goes wrong.
 */
export async function acknowledgeIssue(issueId: string) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Not authorised")

  const issue = await db.event_issues.findUnique({
    where: { id: issueId },
    select: { id: true, event_id: true, acknowledged_at: true },
  })
  if (!issue) throw new Error("Issue not found")

  /*
   * `canOperate`, not `canEdit`. Acknowledging is a live-ops act — the person
   * on the door tonight should be able to do it without also being able to
   * publish or cancel the event.
   *
   * Spread rather than hand-picked: a select missing `venue` reads as "no
   * venue" and silently denies a venue owner.
   */
  const event = await db.events.findUnique({
    where: { id: issue.event_id },
    select: { ...eventPermissionSelect },
  })
  if (!event) throw new Error("Event not found")

  const actor = await actorFor(session.user)
  if (!eventPermissions(actor, event).canOperate) throw new Error("Not authorised")

  // Idempotent, and first-acknowledgement wins: two people on the same alert
  // should not overwrite who actually looked first.
  if (!issue.acknowledged_at) {
    await db.event_issues.update({
      where: { id: issueId },
      data: { acknowledged_at: new Date(), acknowledged_by: session.user.id },
    })
  }

  revalidatePath(`/dashboard/events/${issue.event_id}`)
}
