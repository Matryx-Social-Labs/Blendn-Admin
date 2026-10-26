import type { Metadata } from "next"
import Link from "next/link"

import { PolicyPage } from "@/components/policy-page"
import { COMPANY } from "@/lib/company"

export const metadata: Metadata = { title: "Cancellation & refunds" }

/**
 * What the billing code does, said as policy: cancels stop renewal and run to
 * the end of the paid period (`cancelAnalytics` / `cancelVenuePro`), duplicates
 * and payments that granted nothing are refunded (docs/BILLING-RUNBOOK.md),
 * Blend'n+ is the stores'. A change to either side changes the other.
 */
export default function RefundsPage() {
  return (
    <PolicyPage
      path="/refunds"
      title="Cancellation and refund policy"
      updated="26 October 2026"
      lede={`This policy covers payments made to ${COMPANY.legalName} through the Blend'n dashboard: plans for hosts and venues, and sponsor payment links. Payments are processed by Razorpay.`}
    >
      <h2>Cancelling a monthly or yearly plan</h2>
      <ul>
        <li>
          An owner or admin of the organisation can cancel Analytics or Venue Pro at any time from the
          dashboard&apos;s Plan page.
        </li>
        <li>
          Cancelling stops the plan renewing. Nothing more is charged, and the plan stays on until the end of the
          period already paid for.
        </li>
        <li>
          The period already started is not refunded in part, except in the cases listed under &ldquo;When we
          refund in full&rdquo;.
        </li>
        <li>A plan that was started but never paid for ends at once, with nothing charged.</li>
      </ul>

      <h2>Event Pass</h2>
      <p>
        An Event Pass is a single payment that opens one event&apos;s analytics as soon as the payment is confirmed,
        for good. Because it is delivered on payment, it is not refundable once delivered, except in the cases
        below.
      </p>

      <h2>When we refund in full</h2>
      <ul>
        <li>You were charged twice for the same thing, such as a second subscription or a second pass for the same event.</li>
        <li>You paid and the plan or pass was not delivered, and we cannot deliver it.</li>
        <li>You were charged an amount other than the price shown on our <Link href="/pricing">Pricing</Link> page.</li>
        <li>A sponsor payment link was paid twice, or after the charge it was for had been withdrawn.</li>
      </ul>

      <h2>Sponsor payment links</h2>
      <p>
        A sponsored placement is paid through a Razorpay payment link for the amount agreed with the sponsor. The
        link is valid for 14 days and can be cancelled by us before it is paid. Once paid, a refund of a placement
        follows the sponsorship agreement, and in any case the full-refund cases above.
      </p>

      <h2>How to ask for a refund</h2>
      <ul>
        <li>
          Email <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> or call{" "}
          <a href={COMPANY.phoneHref}>{COMPANY.phone}</a> within 30 days of the payment, with your
          organisation&apos;s name and the payment or invoice reference shown on your Plan page.
        </li>
        <li>We reply within two business days.</li>
        <li>
          An approved refund is issued through Razorpay to the original payment method within 5 to 7 business days.
          Your bank or card issuer may take a few more days to show it.
        </li>
      </ul>

      <h2>Blend&apos;n+ in the app</h2>
      <p>
        Blend&apos;n+ for attendees is sold by Apple through the App Store and by Google through Google Play, not by
        us. Cancel it in your App Store or Google Play subscriptions, and ask Apple or Google for any refund under
        their policies; we cannot refund store purchases. Deleting your Blend&apos;n account does not cancel a
        store subscription.
      </p>

      <h2>Disputes</h2>
      <p>
        If something looks wrong with a charge, contact us first. While a
        payment is disputed with your bank, what it paid for is paused; it is restored if the dispute is resolved in
        our favour.
      </p>
    </PolicyPage>
  )
}
