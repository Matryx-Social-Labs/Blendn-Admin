// Relative import: `scripts/seed-razorpay-review.ts` reads the action names
// through tsx.
import { db } from "./db"

/**
 * The demo organisation Razorpay's website reviewer signs in to
 * (`scripts/seed-razorpay-review.ts`). The reviewer may see everything an
 * organizer sees and open Checkout, and may put nothing in front of a real
 * person: none of its events is ever published, it adds no venue (an
 * unclaimed venue is listed in Places), links none of its events to a real
 * venue (that venue's owner would see it), and invites nobody by email.
 *
 * Which organisation: the one a `razorpay_review.seeded` audit row names,
 * never a name or a slug. The script writes that row in the same transaction
 * as the organisation, so there is no window in which it exists unmarked.
 * Asked only when a request wants one of those things, so an ordinary save
 * costs no query.
 */
export const RAZORPAY_REVIEW_SEEDED = "razorpay_review.seeded"
export const RAZORPAY_REVIEW_REMOVED = "razorpay_review.removed"

export const REVIEW_ORG_REFUSAL =
  "This is a demo organisation for Razorpay’s review: its events stay drafts, and it cannot add venues, link a venue or invite anyone."

type Reader = { audit_logs: Pick<typeof db.audit_logs, "findFirst"> }

export async function isRazorpayReviewOrg(orgId: string | null | undefined, client: Reader = db): Promise<boolean> {
  if (!orgId) return false
  const row = await client.audit_logs.findFirst({
    where: { action: RAZORPAY_REVIEW_SEEDED, resource_id: orgId },
    select: { id: true },
  })
  return row !== null
}

/** The refusal for a request that would publish an event or link a venue, or null. No query when it would do neither. */
export async function reviewOrgRefusal(
  orgId: string | null | undefined,
  wants: { publish?: boolean; venue?: boolean }
): Promise<string | null> {
  if (!wants.publish && !wants.venue) return null
  return (await isRazorpayReviewOrg(orgId)) ? REVIEW_ORG_REFUSAL : null
}
