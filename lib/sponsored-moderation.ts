import type { moderation_status_type } from "@prisma/client"

/**
 * When a sponsored campaign may run, and what an edit does to that.
 *
 * ## The hole this closes
 *
 * Moderation runs at create and edit time rather than per send — a campaign
 * fires every twenty minutes and re-running an image check on identical bytes
 * twenty times a night is waste, not safety.
 *
 * But `[msgId]/route.ts` re-armed the scheduler on ANY PATCH where `is_active`
 * was true, reading `updated.content` straight from the row it had just
 * written. So the sequence
 *
 *     create clean -> get approved -> activate -> PATCH the content
 *
 * put unreviewed text into the room within one interval, with the approval
 * still attached. The gate was decorative for anyone who could edit — which,
 * for sponsored content, means a paying third party posting into a
 * pseudonymous room.
 *
 * ## The rule
 *
 * An edit to the *creative* is a new creative. It cannot inherit the old one's
 * approval, so:
 *
 *   1. any change to content, media_url or media_type forces
 *      `moderation_status = pending` AND `is_active = false`
 *   2. `is_active` cannot be set true while status is anything but `approved`
 *
 * Rule 1 without rule 2 leaves a race — approve, edit, activate in the same
 * breath. Rule 2 without rule 1 lets an edit ride an old approval. Both, or
 * neither is worth having.
 *
 * Changing the *schedule* is not an edit to the creative. Someone moving a
 * campaign from 30 to 45 minutes has not changed a word of what runs, and
 * forcing them back through review for that is the kind of friction that
 * teaches people to route around the review.
 *
 * Pure and dependency-free so the route, the action layer and the test all read
 * the same rule.
 */

/** The fields whose change invalidates an approval. */
export const CREATIVE_FIELDS = ["content", "media_url", "media_type"] as const

export type CreativeFields = {
  [K in (typeof CREATIVE_FIELDS)[number]]?: string | null
}

/**
 * Whether this patch touches the creative.
 *
 * Compares against the current values rather than testing for presence: a UI
 * that submits the whole form every time sends `content` on every save, and
 * treating an unchanged resubmit as an edit would send every campaign back to
 * review for a schedule change.
 */
export function touchesCreative(patch: CreativeFields, current: CreativeFields): boolean {
  return CREATIVE_FIELDS.some((field) => {
    const next = patch[field]
    // Absent means "leave alone", which is not a change. Explicit null is.
    if (next === undefined) return false
    return next !== (current[field] ?? null)
  })
}

export interface ActivationDecision {
  allowed: boolean
  /** Present when refused. Shown to the user, so it names the recovery. */
  reason?: string
}

/**
 * Whether a campaign may be switched on right now.
 *
 * Deliberately returns a sentence rather than a boolean. A greyed-out switch
 * with no explanation is a control that refuses and does not say why, which
 * spends goodwill the product cannot get back — and the seven distinct reasons
 * a campaign cannot run are genuinely different problems with different fixes.
 */
export function canActivate(campaign: {
  moderation_status: moderation_status_type
  sponsor_id: string | null
  hasChatGroup: boolean
  placementApproved: boolean
}): ActivationDecision {
  if (!campaign.sponsor_id) {
    return { allowed: false, reason: "Add a brand to this campaign first." }
  }
  if (!campaign.placementApproved) {
    return {
      allowed: false,
      reason: "This brand's placement at the event has not been approved yet.",
    }
  }
  if (!campaign.hasChatGroup) {
    return { allowed: false, reason: "This event has no chatroom yet." }
  }
  switch (campaign.moderation_status) {
    case "approved":
      return { allowed: true }
    case "pending":
      return { allowed: false, reason: "Creative is in review." }
    case "rejected":
      return {
        allowed: false,
        reason: "Creative was not approved. Edit it and resubmit.",
      }
  }
}

/**
 * The fields to write alongside a creative edit.
 *
 * Returned as an object rather than applied here so the caller keeps one
 * `update` — two writes would leave a window where the content is new and the
 * approval is old, which is the exact state this exists to prevent.
 */
export function creativeEditPatch(): {
  moderation_status: moderation_status_type
  is_active: false
} {
  return { moderation_status: "pending", is_active: false }
}
