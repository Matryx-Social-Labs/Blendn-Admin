"use server"

import { Refusal } from "@/lib/refusal"
import { revalidatePath } from "next/cache"
import type { feedback_sentiment, issue_category } from "@prisma/client"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"

/**
 * Correct a label.
 *
 * A designed affordance rather than an escape hatch: the classifier is wrong
 * about sarcasm often enough that "great, only queued 40 minutes" is a routine
 * case, not an edge one. The correction becomes the record — `source: human`,
 * highest confidence — and is kept for future tuning.
 */
export async function correctFeedbackLabel(
  feedbackId: string,
  sentiment: feedback_sentiment,
  category: issue_category
) {
  const session = await getAuth()
  if (!session?.user) throw new Refusal("Not authenticated")

  const row = await db.event_feedback.findUnique({
    where: { id: feedbackId },
    select: {
      event_id: true,
      event: { select: eventPermissionSelect },
    },
  })
  if (!row) throw new Refusal("Feedback not found")
  if (!eventPermissions(await actorFor(session.user), row.event).canOperate) {
    throw new Refusal("Not authorised to correct this label")
  }

  await db.event_feedback.update({
    where: { id: feedbackId },
    data: {
      sentiment,
      category,
      source: "human",
      confidence: 1,
      corrected_by: session.user.id,
      corrected_at: new Date(),
    },
  })

  auditLog({
    userId: session.user.id,
    action: "feedback.label_corrected",
    resource: "event_feedback",
    resourceId: feedbackId,
    details: { sentiment, category },
  })

  revalidatePath(`/dashboard/events/${row.event_id}/feedback`)
}
