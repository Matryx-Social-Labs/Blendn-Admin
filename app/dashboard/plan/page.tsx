import { redirect } from "next/navigation"
import { IconBuilding } from "@tabler/icons-react"

import { Panel, ProTag } from "@/components/dashboard/kit"
import { PlanCard } from "@/components/dashboard/plan-card"
import { EmptyState } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { billingOrgFor, planPageData, type PlanDate, type PlanPageData } from "@/lib/billing"
import { BILLING_PLANS, grossRupees, gstSplit, rupees } from "@/lib/billing-plans"
import { mayReachRoute } from "@/lib/dashboard-nav"
import { routeMetadata } from "@/lib/dashboard-route-content"
import { venuePlanPage } from "@/lib/venue-plan"

import { AnalyticsBuy, CancelAnalytics, CheckoutProvider, EventPassBuy, PendingWatcher } from "./checkout"
import { VenuePlan } from "./venue-plan"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/plan")

export const dynamic = "force-dynamic"

/**
 * An organisation's plan: Free, an Event Pass for one event, or Analytics
 * (plan v2 §9.1b; the kit's Plan screen, `screens-org.jsx`).
 *
 * What it says about the plan comes from the server's own rows: the
 * entitlement (`lib/entitlements.ts`) and the subscription as Razorpay last
 * reported it. `?status=pending` is only the browser saying it came back from
 * Checkout; it changes the sentence and holds Buy back while the page waits
 * for the webhook, never the plan.
 *
 * Every price is the GST-inclusive figure with its split beneath it, the same
 * number the statement will show (the screen's one memorable detail).
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
const day = (d: Date) => DAY.format(d)
const dated = (d: PlanDate | null) => (d ? `${d.word} ${day(d.at)}` : null)

const FREE = [
  "Unlimited events and drafts",
  "QR code and link for every event",
  "GPS check-in inside your geofence",
  "Live headcount, arrivals and alerts",
  "Moderated room chat and announcements",
  "Turn-up, connections and ratings for each event",
  "Attendees by label, came-back count and no-show rate",
  "Team access, audit log, and CSVs of events, attendees and check-ins",
]
const PASS = [
  "How long people stayed",
  "Arrivals, replayed in 10-minute steps",
  "First-time vs returning guests",
  "App views → RSVPs (app views only)",
]
const ANALYTICS = [
  "Every Event Pass feature, for every event",
  "Who came back within 30, 60 and 90 days",
  "RSVP pacing against your median, not just your last event",
  "Every event side by side",
  "30 days, 90 days or all time",
]

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; for?: string; ref?: string }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (!mayReachRoute(session.user.role, "/dashboard/plan")) redirect("/dashboard")

  // A venue owner's plan is each venue's (step 17).
  if (session.user.role === "venue_owner") {
    const params = await searchParams
    const view = await venuePlanPage({ id: session.user.id, role: session.user.role })
    // Waiting until the webhook has moved the subscription Checkout came back
    // with past `created`; then the plan is on the page and nothing waits.
    const arrived = view.venues.some((v) => v.subscriptions.some((s) => s.providerRef === params.ref && s.status !== "created"))
    const pending = params.status === "pending" && params.for === "venue" && !arrived
    return (
      <>
        <VenuePlan view={view} pending={pending} />
        {pending ? <PendingWatcher reference={params.ref ?? null} /> : null}
      </>
    )
  }

  const org = await billingOrgFor({ id: session.user.id, role: session.user.role })
  if (!org) {
    return (
      <EmptyState
        icon={<IconBuilding />}
        title="No organisation yet"
        description="A plan belongs to an organisation. Once you're part of one, its plan is here."
      />
    )
  }

  const view = await planPageData(org)
  const params = await searchParams
  const pendingFor = params.for === "pass" ? "pass" : "analytics"
  // Waiting for the webhook: the browser came back from Checkout and the
  // server has not granted anything yet. A pass shows up as an event leaving
  // the "still locked" list, which the page cannot tie to the one bought, so
  // it waits on the time-out instead.
  const pending = params.status === "pending" && !(pendingFor === "analytics" && view.analytics)
  const canBuy = view.paymentsOn && org.mayBuy

  const cards = (
    <div className="grid grid-cols-1 gap-5 @3xl/main:grid-cols-3">
      <PlanCard name="Free" current={!view.analytics} items={FREE}>
        <p className="text-[1.625rem] font-bold tabular-nums">₹0</p>
      </PlanCard>

      <PlanCard name="Event Pass" tag={<ProTag />} items={PASS}>
        <div className="flex flex-col gap-1">
          <p className="text-[1.625rem] font-bold tabular-nums">
            {rupees(grossRupees(BILLING_PLANS.event_pass))}{" "}
            <span className="text-[0.8125rem] font-normal text-muted-foreground">per event</span>
          </p>
          <p className="text-[0.75rem] tabular-nums text-faint-foreground">
            {gstSplit(BILLING_PLANS.event_pass)} · one payment, that event for good
          </p>
        </div>
        {view.analytics ? (
          <p className="text-[0.8125rem] text-muted-foreground">Analytics already covers every event.</p>
        ) : view.free.reason === "free_window" ? (
          <p className="text-[0.8125rem] text-muted-foreground">Every event is open while Analytics is free.</p>
        ) : (
          <EventPassBuy
            enabled={canBuy}
            pending={pending}
            events={view.events.map((e) => ({ id: e.id, label: `${e.title} · ${day(e.startsAt)}` }))}
          />
        )}
      </PlanCard>

      <PlanCard name="Analytics" tag={<ProTag />} brand current={Boolean(view.analytics)} items={ANALYTICS}>
        {view.analytics ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            {view.date ? `On, ${dated(view.date)}.` : "On."}
          </p>
        ) : (
          <AnalyticsBuy enabled={canBuy} pending={pending} />
        )}
      </PlanCard>
    </div>
  )

  return (
    <>
      <StatusPanel view={view} pending={pending} pendingFor={pendingFor} />
      {pending ? <PendingWatcher reference={params.ref ?? null} /> : null}
      <Subscriptions view={view} />

      {canBuy ? <CheckoutProvider>{cards}</CheckoutProvider> : cards}

      {!org.mayBuy ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Only an owner or admin of {org.orgName} can change its plan.
        </p>
      ) : !view.paymentsOn ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Payments aren&apos;t switched on here yet, so nothing can be bought on this page.
        </p>
      ) : null}

      <Payments view={view} />
    </>
  )
}

function StatusPanel({ view, pending, pendingFor }: { view: PlanPageData; pending: boolean; pendingFor: "pass" | "analytics" }) {
  const halted = view.subscriptions.some((s) => s.status === "halted")
  let headline: string
  let detail: string

  if (halted) {
    headline = "Analytics is paused"
    detail = "Razorpay couldn't take the last payment. Update the card or UPI mandate from Razorpay's email, or cancel below."
  } else if (view.analytics?.source === "grant") {
    headline = "Analytics · founding grant"
    detail = view.date ? `Given by Blend'n, on ${dated(view.date)}. Nothing is charged.` : "Given by Blend'n."
  } else if (view.analytics) {
    const sub = view.subscriptions[0]
    headline = sub ? `Analytics · ${BILLING_PLANS[sub.planKey].period === "yearly" ? "yearly" : "monthly"}` : "Analytics"
    detail =
      view.date?.word === "renews" && sub
        ? `Renews ${day(view.date.at)} for ${rupees(grossRupees(BILLING_PLANS[sub.planKey]))}.`
        : view.date
          ? `On until ${day(view.date.at)}, then Free.`
          : "On."
  } else if (pending) {
    headline = "Payment sent"
    detail =
      pendingFor === "pass"
        ? "The Event Pass opens that event's analytics as soon as Razorpay confirms the payment, usually within a minute."
        : "Analytics switches on as soon as Razorpay confirms the payment, usually within a minute."
  } else if (view.free.reason === "free_window" && view.free.until) {
    headline = `Free · Analytics open until ${day(view.free.until)}`
    detail = `Your first event that cleared the privacy floor${view.free.firstEventTitle ? `, ${view.free.firstEventTitle},` : ""} opened every Analytics view for 30 days. That event stays open for good.`
  } else if (view.free.reason === "free_window") {
    headline = "Free · Analytics open for now"
    detail = "Every Analytics view is open until 30 days after your first event with at least 5 people checked in."
  } else {
    headline = "Free"
    detail = view.free.firstEventTitle
      ? `Every event you run, and its own numbers, cost nothing. ${view.free.firstEventTitle}'s analytics stay open for good.`
      : "Every event you run, and the numbers you see for each one, cost nothing."
  }

  return (
    <Panel>
      {/* Words only inside the live region; the controls sit beside it. */}
      <div role="status" className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <p className="text-[0.9375rem] font-bold">{headline}</p>
        <p className="text-[0.8125rem] text-muted-foreground">{detail}</p>
      </div>
    </Panel>
  )
}

/** Every subscription that could still charge, so a second one is never invisible. */
function Subscriptions({ view }: { view: PlanPageData }) {
  if (view.subscriptions.length === 0) return null
  const cancellable = view.subscriptions.filter((s) => !s.cancelAtCycleEnd)
  const mayCancel = view.org.mayBuy && view.paymentsOn && cancellable.length > 0
  return (
    <Panel title="Subscriptions" hint="each one Razorpay could still charge">
      <ul className="flex flex-col">
        {view.subscriptions.map((s) => (
          <li key={s.providerRef} className="flex flex-wrap items-baseline gap-x-3 border-t border-border py-2 text-[0.8125rem] first:border-t-0">
            <span className="font-medium">{BILLING_PLANS[s.planKey].label}</span>
            <span className="text-muted-foreground">
              {s.status === "created"
                ? "waiting for payment"
                : s.cancelAtCycleEnd
                  ? `ends ${s.currentEnd ? day(s.currentEnd) : "at the cycle's end"}`
                  : s.status === "active" && s.currentEnd
                    ? `renews ${day(s.currentEnd)}`
                    : s.status}
            </span>
            <span className="font-mono text-[0.75rem] text-faint-foreground">{s.providerRef}</span>
          </li>
        ))}
      </ul>
      {mayCancel ? (
        <div>
          <CancelAnalytics running={cancellable.some((s) => s.status === "active")} />
        </div>
      ) : null}
    </Panel>
  )
}

const PAYMENT_STATUS: Record<string, string> = {
  refunded: "refunded",
  disputed: "disputed",
  dispute_lost: "dispute lost",
  dispute_won: "dispute won",
}

function Payments({ view }: { view: PlanPageData }) {
  return (
    <Panel title="Payments" hint="Invoices are issued through Razorpay by Matryx Social Labs Private Limited">
      {view.payments.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          Nothing paid yet. Each payment appears here with its Razorpay invoice or payment reference.
        </p>
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
                  {p.label}
                  {PAYMENT_STATUS[p.status] ? <span className="text-muted-foreground"> · {PAYMENT_STATUS[p.status]}</span> : null}
                </td>
                <td className="py-2 font-mono text-[0.75rem] text-muted-foreground">{p.reference}</td>
                <td className="py-2 text-right tabular-nums">{rupees(p.amountMinor / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
