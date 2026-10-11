import "server-only"

import { db } from "../db"
import { logger } from "../logger"
import { sendBulkPushNotifications } from "../push-notifications"

/**
 * Deliver an offer to the people it was sent to (step 12): one push each,
 * and a line in their bell.
 *
 * **The only module that reads an offer audience's ids**
 * (`__tests__/regulars-never-listed.test.ts`). The send wrote them with one
 * `INSERT … SELECT` that returned none to the code (lib/offer-actions.ts);
 * this reads them back to address the pushes and hands them to nobody else.
 *
 * ## What a lock screen shows
 *
 * Nothing that says where. A lock screen is read by whoever picks the phone
 * up, and "Toit sent you a free drink" says where somebody spends their
 * nights. The push says an offer is waiting; the venue and its words appear
 * when the person opens the app (`GET /api/mobile/offers/:id`). The bell
 * stores the same two lines, so it holds no venue either.
 *
 * Called after the send commits, not awaited by it. ponytail: one attempt; a
 * process that dies between the commit and the push leaves the offer in the
 * app with no push. Add a `pushed_at` column and a sweep if that is ever seen.
 */

export const OFFER_PUSH_TITLE = "An offer for you"
export const OFFER_PUSH_BODY = "A place you keep going back to sent you something. Open Blendn to see it."

export async function deliverOffer(offerId: string): Promise<void> {
  try {
    const sends = await db.venue_offer_sends.findMany({ where: { offer_id: offerId }, select: { user_id: true } })
    if (sends.length === 0) return
    const { sent, failed } = await sendBulkPushNotifications({
      userIds: sends.map((s) => s.user_id),
      title: OFFER_PUSH_TITLE,
      body: OFFER_PUSH_BODY,
      data: { type: "venue_offer", offerId },
    })
    logger.info("Offer delivered", { offerId, recipients: sends.length, sent, failed })
  } catch (error) {
    logger.error("Offer delivery failed", { offerId, error: error instanceof Error ? error.message : String(error) })
  }
}
