import type { Metadata } from "next"

import { PolicyPage } from "@/components/policy-page"
import { COMPANY } from "@/lib/company"

export const metadata: Metadata = { title: "Contact" }

export default function ContactPage() {
  return (
    <PolicyPage path="/contact" title="Contact us" updated="26 October 2026">
      <h2>{COMPANY.legalName}</h2>
      <p>
        Registered and operating address:
        <br />
        {COMPANY.address}
      </p>

      <h2>Billing, plans and anything else</h2>
      <ul>
        <li>
          Email: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
        </li>
        <li>
          Phone: <a href={COMPANY.phoneHref}>{COMPANY.phone}</a>
        </li>
      </ul>
      <p>We reply within two business days. For a payment, include your organisation&apos;s name and the Razorpay payment or invoice reference from your Plan page.</p>

      <h2>Privacy and your data</h2>
      <p>
        <a href={`mailto:${COMPANY.privacyEmail}`}>{COMPANY.privacyEmail}</a>
      </p>

      <h2>Grievance officer</h2>
      <p>
        {COMPANY.grievance.name}, {COMPANY.grievance.title}
        <br />
        <a href={`mailto:${COMPANY.grievance.email}`}>{COMPANY.grievance.email}</a>, or by post to the address above.
      </p>
    </PolicyPage>
  )
}
