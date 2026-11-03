import type { Metadata } from "next"

import { PolicyPage } from "@/components/policy-page"

// A draft: not for search engines until the lawyer signs it off.
export const metadata: Metadata = { title: "Ticket terms of sale (draft)", robots: { index: false, follow: false } }

/**
 * The buyer's terms of sale for tickets (contract §8.7), linked from the pay
 * page and the app's checkout. The text is the buyer section of the organizer
 * ticketing terms draft v0.1 (`.context/plans/organizer-ticketing-terms-draft.md`)
 * and stays marked draft until legal review; change both together.
 */
export default function TicketTermsPage() {
  return (
    <PolicyPage
      path="/terms"
      title="Ticket terms of sale"
      updated="2 November 2026"
      lede={
        <strong role="note" className="text-foreground">
          Draft v0.1, pending legal review. These terms will change before tickets go on sale.
        </strong>
      }
    >
      <ul>
        <li>You are buying from the organizer named on the event. Blend&apos;n collects payment on their behalf.</li>
        <li>The booking fee covers Blend&apos;n&apos;s service, tax on it, and payment processing.</li>
        <li>
          Refunds follow the organizer&apos;s policy shown before you pay. If the event is cancelled you get everything back, booking fee
          included.
        </li>
        <li>Your ticket is in the Blend&apos;n app under Going. Show its code or QR at the door. One entry per ticket. 18+ only.</li>
      </ul>
    </PolicyPage>
  )
}
