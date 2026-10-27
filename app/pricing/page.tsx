import type { Metadata } from "next"

import { PolicyPage } from "@/components/policy-page"
import { BILLING_PLANS, grossRupees, gstSplit, rupees, type BillingPlan } from "@/lib/billing-plans"

export const metadata: Metadata = { title: "Pricing" }

/**
 * What the dashboard sells, read from `lib/billing-plans.ts` — the one place
 * a price lives, and the table Razorpay charges from — so this page cannot
 * quote a price the checkout does not take. The first figure is what is
 * charged, GST included; the split sits under it, as on the Plan page.
 */

interface Row {
  name: string
  detail?: string
  billed: string
  plan: BillingPlan | null
}

const HOSTS: Row[] = [
  { name: "Free", detail: "Events, GPS check-in, live headcount, room chat and each event's own numbers", billed: "—", plan: null },
  { name: "Event Pass", detail: "Deeper analytics for one event, for good", billed: "Once, per event", plan: BILLING_PLANS.event_pass },
  {
    name: "Analytics",
    detail: "Every Event Pass feature for every event, plus return rates and comparisons",
    billed: "Monthly",
    plan: BILLING_PLANS.analytics_monthly,
  },
  { name: "Analytics", billed: "Yearly", plan: BILLING_PLANS.analytics_yearly },
]

const VENUES: Row[] = [
  {
    name: "Venue Pro, per venue",
    detail: "12 months of guests by day and time, regulars and returning share",
    billed: "Monthly",
    plan: BILLING_PLANS.venue_pro_monthly,
  },
  { name: "Venue Pro, per venue", billed: "Yearly", plan: BILLING_PLANS.venue_pro_yearly },
]

function PriceTable({ caption, rows }: { caption: string; rows: Row[] }) {
  return (
    <table className="w-full table-fixed border-collapse text-[0.8125rem]">
      <caption className="sr-only">{caption}</caption>
      <colgroup>
        <col />
        <col className="w-[26%] sm:w-[22%]" />
        <col className="w-[30%] sm:w-[26%]" />
      </colgroup>
      <thead>
        <tr className="text-left text-[0.75rem] text-faint-foreground">
          <th scope="col" className="pb-1.5 font-medium">Plan</th>
          <th scope="col" className="pb-1.5 font-medium">Billed</th>
          <th scope="col" className="pb-1.5 text-right font-medium">You pay</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.name}-${r.billed}`} className="border-t border-border align-top">
            <td className="py-2.5 pr-3">
              <span className="text-foreground">{r.name}</span>
              {r.detail ? <span className="block text-[0.75rem] text-faint-foreground">{r.detail}</span> : null}
            </td>
            <td className="py-2.5 pr-3">{r.billed}</td>
            <td className="py-2.5 text-right tabular-nums">
              <span className="text-foreground">{r.plan ? rupees(grossRupees(r.plan)) : rupees(0)}</span>
              {r.plan ? (
                <span className="block text-[0.75rem] text-faint-foreground">{gstSplit(r.plan)}</span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function PricingPage() {
  return (
    <PolicyPage
      path="/pricing"
      title="Pricing"
      updated="26 October 2026"
      lede="What the Blend'n dashboard sells to event hosts, venues and sponsors. Prices are in Indian rupees; the first figure is what you pay, GST included."
    >
      <h2>Hosts (organizers)</h2>
      <PriceTable caption="Plans for hosts" rows={HOSTS} />
      <p className="mt-3 text-[0.8125rem]">
        Analytics is free for a new organisation until 30 days after its first event with at least five people
        checked in, and that event&apos;s analytics stay free for good.
      </p>

      <h2>Venues</h2>
      <PriceTable caption="Plans for venues" rows={VENUES} />
      <p className="mt-3 text-[0.8125rem]">
        Listing a venue on Blend&apos;n is free. Venue Pro can be bought once the venue has four weeks of data.
      </p>

      <h2>Sponsors</h2>
      <p>
        Sponsored placements are priced by agreement, by the reach they deliver, and paid through a Razorpay
        payment link emailed to the sponsor for the agreed amount.
      </p>

      <h2>How you pay</h2>
      <p>
        Plans are bought on the dashboard&apos;s Plan page, by the organisation&apos;s owner or an admin, and paid
        through Razorpay&apos;s checkout. Monthly and yearly plans renew automatically until cancelled; an Event
        Pass is a single payment. Every payment is listed on the Plan page with its Razorpay invoice or payment
        reference.
      </p>

      <h2>Not sold here</h2>
      <p>Blend&apos;n+ for attendees is bought inside the Blend&apos;n app, through the App Store or Google Play.</p>
    </PolicyPage>
  )
}
