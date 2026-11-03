// Relative imports: reached from server.ts through lib/ticket-payments.ts (`build:server`, plain tsc).
import { db } from "./db"

/**
 * An organisation's payouts, as the dashboard shows them and `enableTicketing`
 * gates on (SCRUM-1011): its Razorpay Route linked account and that account's
 * onboarding state, which mirrors Razorpay's word. Only `active`, with an
 * account id, sells and is paid.
 */

export type PayoutAccountStatus = "not_started" | "pending" | "active" | "rejected"

/** Whether the organisation can be paid: an active linked account with its id. */
export const payoutsConnected = (org: { razorpay_account_id: string | null; razorpay_account_status: string }): boolean =>
  org.razorpay_account_status === "active" && org.razorpay_account_id !== null

export interface PayoutStatus {
  status: PayoutAccountStatus
  /** `acc_…`, or null before Razorpay issued one. */
  linkedAccountId: string | null
  /** May turn ticketing on: `enableTicketing` refuses `payouts_not_connected` otherwise. */
  connected: boolean
}

/** The organisation's payout account for the dashboard, or null for an organisation that does not exist. */
export async function payoutStatus(orgId: string): Promise<PayoutStatus | null> {
  const org = await db.organisations.findUnique({ where: { id: orgId }, select: { razorpay_account_id: true, razorpay_account_status: true } })
  if (!org) return null
  return { status: org.razorpay_account_status, linkedAccountId: org.razorpay_account_id, connected: payoutsConnected(org) }
}
