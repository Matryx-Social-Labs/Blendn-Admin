import Link from "next/link"

import { Panel, ProTag } from "@/components/dashboard/kit"
import { PlanCard } from "@/components/dashboard/plan-card"
import { BILLING_PLANS, grossRupees, gstSplit, rupees } from "@/lib/billing-plans"
import { VENUE_DATA_DAYS, type VenuePlanPage, type VenuePlanRow } from "@/lib/venue-plan"

import { CancelAnalytics, CheckoutProvider, VenueProBuy } from "./checkout"

/**
 * A venue owner's Plan page (plan v2 §9.1b, audit §6.2): every venue the
 * organisation owns, Listed or on Venue Pro, and what Pro adds.
 *
 * Nothing is charged until a venue has four weeks of venue-day data; each
 * venue's row says how far along it is (the screen's memorable detail: "19 of
 * 28 days of data"), and Buy appears only when it is past it, payments are on
 * and the person may buy. The plan itself is read from the server's own rows;
 * `?status=pending` only holds Buy back while the webhook is awaited.
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
const day = (d: Date) => DAY.format(d)

const LISTED = [
  "Your venue on the map and in Places, live from day one",
  "Who is in the building now, against your licence",
  "Operate every night at your venue after your claim",
  "Last 30 days: guests by day and time, regulars, returning share",
]
const PRO = [
  "12 months of guests by day and time, regulars and returning share",
  "Your venue's history from before your claim, as totals",
  "Blind offers to your regulars, with a monthly send quota (coming)",
  "Perks for Blendn+ members (coming)",
]

export function VenuePlan({ view, pending }: { view: VenuePlanPage; pending: boolean }) {
  const monthly = BILLING_PLANS.venue_pro_monthly
  const yearly = BILLING_PLANS.venue_pro_yearly
  const anyBuyable = view.paymentsOn && view.venues.some((v) => v.mayBuy && v.readiness.chargeable && !v.pro)

  const cards = (
    <div className="grid grid-cols-1 gap-5 @3xl/main:grid-cols-2">
      <PlanCard name="Listed" items={LISTED}>
        <p className="text-[1.625rem] font-bold tabular-nums">₹0</p>
      </PlanCard>
      <PlanCard name="Venue Pro" tag={<ProTag plan="Venue Pro" />} brand items={PRO}>
        <div className="flex flex-col gap-1">
          <p className="text-[1.625rem] font-bold tabular-nums">
            {rupees(grossRupees(monthly))} <span className="text-[0.8125rem] font-normal text-muted-foreground">/ month per venue</span>
          </p>
          <p className="text-[0.75rem] tabular-nums text-faint-foreground">
            {gstSplit(monthly)} · or {rupees(grossRupees(yearly))} a year, two months free
          </p>
        </div>
        <p className="text-[0.8125rem] text-muted-foreground">
          Nothing is charged until a venue has {VENUE_DATA_DAYS / 7} weeks of data from people going live there.
        </p>
      </PlanCard>
    </div>
  )

  const page = (
    <>
      <Panel title="Your venues" hint="each venue has its own plan" bodyClassName="gap-0 px-0 pb-0 pt-3">
        {view.venues.length === 0 ? (
          <p className="px-5 pb-5 text-[0.8125rem] text-muted-foreground">
            No venue yet. <Link href="/dashboard/venues/new" className="underline underline-offset-2">Add or claim one</Link>{" "}
            and its plan is here.
          </p>
        ) : (
          <ul className="flex flex-col">
            {view.venues.map((v) => (
              <VenueRow key={v.venueId} venue={v} paymentsOn={view.paymentsOn} pending={pending} />
            ))}
          </ul>
        )}
      </Panel>

      {cards}

      {!view.paymentsOn ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Payments aren&apos;t switched on here yet, so nothing can be bought on this page.
        </p>
      ) : null}

      <Panel title="Payments" hint="Invoices are issued through Razorpay by Matryx Social Labs Private Limited">
        {view.payments.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground">Nothing paid yet.</p>
        ) : (
          <table className="w-full text-[0.8125rem]">
            <caption className="sr-only">Payments</caption>
            <thead>
              <tr className="text-left text-[0.75rem] text-faint-foreground">
                <th scope="col" className="pb-2 font-medium">Date</th>
                <th scope="col" className="pb-2 font-medium">For</th>
                <th scope="col" className="pb-2 font-medium">Reference</th>
                <th scope="col" className="pb-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {view.payments.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-2">{day(p.at)}</td>
                  <td className="py-2">
                    {p.label} · {p.venueName}
                    {p.status !== "captured" ? <span className="text-muted-foreground"> · {p.status.replace("_", " ")}</span> : null}
                  </td>
                  <td className="py-2 font-mono text-[0.75rem] text-muted-foreground">{p.reference}</td>
                  <td className="py-2 text-right tabular-nums">{rupees(p.amountMinor / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
  // Checkout.js loads only for someone who can buy something here now.
  return anyBuyable ? <CheckoutProvider>{page}</CheckoutProvider> : page
}

/** One venue: its plan, how close it is to chargeable, and what may be done about it. */
function VenueRow({ venue, paymentsOn, pending }: { venue: VenuePlanRow; paymentsOn: boolean; pending: boolean }) {
  const { readiness, pro } = venue
  const halted = venue.subscriptions.some((s) => s.status === "halted")
  const state = halted
    ? "Venue Pro · paused: Razorpay couldn't take the last payment"
    : pro?.source === "grant"
      ? `Venue Pro · founding grant${pro.expiresAt ? ` until ${day(pro.expiresAt)}` : ""}`
      : pro
        ? `Venue Pro${venue.date ? ` · ${venue.date.word} ${day(venue.date.at)}` : ""}`
        : "Listed"
  const cancellable = venue.subscriptions.filter((s) => !s.cancelAtCycleEnd)

  return (
    <li className="flex flex-col gap-3 border-t border-border px-5 py-4 @3xl/main:flex-row @3xl/main:items-start @3xl/main:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-[0.9375rem] font-bold">
          <Link href={`/dashboard/venues/${venue.venueId}`} className="underline-offset-4 hover:underline">
            {venue.name}
          </Link>
          <span className="font-normal text-muted-foreground"> · {state}</span>
        </p>
        <DataMeter venue={venue} />
        {!venue.mayBuy ? (
          <p className="text-[0.75rem] text-faint-foreground">Only an owner or admin of {venue.orgName} can change this venue&apos;s plan.</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 @3xl/main:w-[300px]">
        {pro ? (
          cancellable.length > 0 && venue.mayBuy && paymentsOn ? (
            <CancelAnalytics running={cancellable.some((s) => s.status === "active")} venueId={venue.venueId} />
          ) : null
        ) : readiness.chargeable && venue.mayBuy && paymentsOn ? (
          <VenueProBuy venueId={venue.venueId} enabled pending={pending} />
        ) : null}
      </div>
    </li>
  )
}

/**
 * The no-charge rule, said as a count: days of venue-day data out of the 28
 * that must pass before a venue can be charged.
 */
function DataMeter({ venue }: { venue: VenuePlanRow }) {
  const { readiness } = venue
  if (readiness.chargeable) {
    return <p className="text-[0.75rem] text-faint-foreground">{VENUE_DATA_DAYS} of {VENUE_DATA_DAYS} days of data · Venue Pro can be bought</p>
  }
  const pct = Math.round((readiness.dataDays / VENUE_DATA_DAYS) * 100)
  return (
    <div className="flex flex-col gap-1">
      <div
        role="meter"
        aria-label={`Days of data at ${venue.name}`}
        aria-valuemin={0}
        aria-valuemax={VENUE_DATA_DAYS}
        aria-valuenow={readiness.dataDays}
        className="h-1.5 w-48 overflow-hidden rounded-full bg-surface-raised"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[0.75rem] text-faint-foreground">
        {readiness.chargeableFrom
          ? `${readiness.dataDays} of ${VENUE_DATA_DAYS} days of data · no charge before ${day(readiness.chargeableFrom)}`
          : `No data yet · charges start ${VENUE_DATA_DAYS} days after people first go live here`}
      </p>
    </div>
  )
}
