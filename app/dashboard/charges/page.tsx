import { redirect } from "next/navigation"

import { ChargeLedgerView } from "@/components/charge-ledger"
import { getAuth } from "@/lib/auth"
import { getChargeLedger } from "@/lib/charge-actions"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/charges")

export const dynamic = "force-dynamic"

/**
 * What each placement costs and whether it has been paid.
 *
 * An admin prices a placement, marks it agreed and sends the sponsor a Razorpay
 * Payment Link (`sendPaymentLink`); `payment_link.paid` settles the charge
 * (`lib/razorpay-webhook.ts`). Money that arrives another way is settled here by
 * hand, with its bank reference. Not an invoice: a charge has no number and no
 * tax lines. What is recorded is what was agreed, so six months later there is
 * one answer instead of a thread in somebody's inbox.
 */
export default async function ChargesPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const ledger = await getChargeLedger()

  return <ChargeLedgerView ledger={ledger} />
}
