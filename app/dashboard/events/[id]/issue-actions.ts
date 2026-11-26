"use server"

import { Refusal } from "@/lib/refusal"
import { revalidatePath } from "next/cache"

import { auditInTx } from "@/lib/audit-log"
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
  if (!session?.user) throw new Refusal("Not authorised")

  const issue = await db.event_issues.findUnique({
    where: { id: issueId },
    select: { id: true, event_id: true, kind: true },
  })
  if (!issue) throw new Refusal("Issue not found")

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
  if (!event) throw new Refusal("Event not found")

  const actor = await actorFor(session.user)
  if (!eventPermissions(actor, event).canOperate) throw new Refusal("Not authorised")

  // Idempotent, and first-acknowledgement wins: two people on the same alert
  // should not overwrite who actually looked first. The condition is in the
  // write, so of two at once only one acknowledges, and only that one is
  // audited. The row names the issue and its kind, never the alert's wording.
  const userId = session.user.id
  await db.$transaction(async (tx) => {
    const { count } = await tx.event_issues.updateMany({
      where: { id: issueId, acknowledged_at: null },
      data: { acknowledged_at: new Date(), acknowledged_by: userId },
    })
    if (count === 0) return
    await auditInTx(tx, {
      userId,
      action: "event.issue_acknowledged",
      resource: "event",
      resourceId: issue.event_id,
      details: { issueId: issue.id, kind: issue.kind },
    })
  })

  revalidatePath(`/dashboard/events/${issue.event_id}`)
}
