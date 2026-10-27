import type { Metadata } from "next"
import Link from "next/link"

import { PolicyPage } from "@/components/policy-page"
import { COMPANY } from "@/lib/company"

export const metadata: Metadata = { title: "Shipping & delivery" }

/**
 * Nothing is shipped: what is sold is access, granted when Razorpay's signed
 * webhook confirms the payment (`lib/razorpay-webhook.ts`), usually within a
 * minute — the Plan page says the same while it waits.
 */
export default function ShippingPage() {
  return (
    <PolicyPage
      path="/shipping"
      title="Shipping and delivery policy"
      updated="26 October 2026"
      lede="Everything sold on the Blend'n dashboard is a digital service. Nothing is shipped, and there are no shipping charges."
    >
      <h2>How a purchase is delivered</h2>
      <ul>
        <li>
          <strong>Analytics and Venue Pro</strong> switch on for your organisation, or for the venue, as soon as
          Razorpay confirms the payment, usually within a minute. Each renewal keeps them on without anything to do.
        </li>
        <li>
          <strong>An Event Pass</strong> opens that event&apos;s analytics as soon as the payment is confirmed.
        </li>
        <li>
          <strong>A sponsor payment</strong> settles the agreed charge, and the placement runs as agreed with the
          sponsor.
        </li>
      </ul>
      <p>
        Delivery is to your account on the Blend&apos;n dashboard, where the Plan page shows what is on and until when,
        with each payment&apos;s Razorpay invoice or payment reference. It is available wherever you can sign in.
      </p>

      <h2>If it has not arrived</h2>
      <p>
        If a paid plan or pass is not on your Plan page within 24 hours of the payment, email{" "}
        <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a> or call <a href={COMPANY.phoneHref}>{COMPANY.phone}</a>{" "}
        with the payment reference. We will switch it on, or refund it in full under our{" "}
        <Link href="/refunds">cancellation and refund policy</Link>.
      </p>

      <h2>Blend&apos;n+ in the app</h2>
      <p>Blend&apos;n+ is delivered in the Blend&apos;n app by Apple or Google when the store confirms the purchase.</p>
    </PolicyPage>
  )
}
