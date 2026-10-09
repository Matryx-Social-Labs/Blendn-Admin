import { redirect } from "next/navigation"
import { IconBuilding, IconCheck } from "@tabler/icons-react"

import { Panel, ProTag } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { getAuth } from "@/lib/auth"
import { billingOrgFor, planPageData, type PlanPageData } from "@/lib/billing"
import { BILLING_PLANS, grossRupees, gstSplit, rupees } from "@/lib/billing-plans"
import { mayReachRoute } from "@/lib/dashboard-nav"
import { routeMetadata } from "@/lib/dashboard-route-content"
import { cn } from "@/lib/utils"

import { AnalyticsBuy, CancelAnalytics, CheckoutScript, EventPassBuy } from "./checkout"

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
 * Checkout; it changes the sentence, never the plan.
 *
 * Every price is the GST-inclusive figure with its split beneath it, the same
 * number the statement will show (the screen's one memorable detail).
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })
const day = (d: Date) => DAY.format(d)

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

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (!mayReachRoute(session.user.role, "/dashboard/plan")) redirect("/dashboard")

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
  const { status } = await searchParams
  const canBuy = view.paymentsOn && org.mayBuy

  return (
    <>
      {canBuy ? <CheckoutScript /> : null}
      <StatusPanel view={view} pending={status === "pending"} />

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
              events={view.events.map((e) => ({ id: e.id, label: `${e.title} · ${day(e.startsAt)}` }))}
            />
          )}
        </PlanCard>

        <PlanCard name="Analytics" tag={<ProTag />} brand current={Boolean(view.analytics)} items={ANALYTICS}>
          {view.analytics ? (
            <p className="text-[0.8125rem] text-muted-foreground">
              {/* A subscription's dates are in the status line above; the row's end adds a renewal grace. */}
              {view.subscription
                ? "On, with your subscription."
                : view.analytics.expiresAt
                  ? `On until ${day(view.analytics.expiresAt)}.`
                  : "On."}
            </p>
          ) : (
            <AnalyticsBuy enabled={canBuy} />
          )}
        </PlanCard>
      </div>

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

function StatusPanel({ view, pending }: { view: PlanPageData; pending: boolean }) {
  const sub = view.subscription
  const plan = sub ? BILLING_PLANS[sub.planKey] : null
  let headline: string
  let detail: string

  if (sub?.status === "halted") {
    headline = "Analytics is paused"
    detail = "Razorpay couldn't take the last payment. Update the card or UPI mandate from Razorpay's email, or cancel below."
  } else if (view.analytics?.source === "grant") {
    headline = "Analytics · founding grant"
    detail = view.analytics.expiresAt ? `Given by Blend'n, on until ${day(view.analytics.expiresAt)}. Nothing is charged.` : "Given by Blend'n."
  } else if (view.analytics && sub && plan) {
    headline = `Analytics · ${plan.period === "yearly" ? "yearly" : "monthly"}`
    detail = sub.cancelAtCycleEnd
      ? `Cancelled. On until ${sub.currentEnd ? day(sub.currentEnd) : "the end of this cycle"}, then Free.`
      : `Renews ${sub.currentEnd ? day(sub.currentEnd) : "each cycle"} for ${rupees(grossRupees(plan))}.`
  } else if (view.analytics) {
    headline = "Analytics"
    detail = view.analytics.expiresAt ? `On until ${day(view.analytics.expiresAt)}.` : "On."
  } else if (pending) {
    headline = "Payment sent"
    detail = "Analytics switches on as soon as Razorpay confirms the payment, usually within a minute. Refresh to check."
  } else if (view.free.reason === "free_window" && view.free.until) {
    headline = `Free · Analytics open until ${day(view.free.until)}`
    detail = `Your first event that cleared the privacy floor${view.free.firstEventTitle ? `, ${view.free.firstEventTitle},` : ""} opened every Analytics view for 30 days. That event stays open for good.`
  } else if (view.free.reason === "free_window") {
    headline = "Free · Analytics open for now"
    detail = "Every Analytics view is open until 30 days after your first event with at least 5 people checked in."
  } else {
    headline = "Free"
    detail = view.free.firstEventTitle
      ? `Every event you run, and its own numbers, cost nothing. ${view.free.firstEventTitle}'s Analytics stay open for good.`
      : "Every event you run, and its own numbers, cost nothing."
  }

  const mayCancel = view.org.mayBuy && sub && !sub.cancelAtCycleEnd && view.paymentsOn
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2" role="status">
        <p className="text-[0.9375rem] font-bold">{headline}</p>
        <p className="text-[0.8125rem] text-muted-foreground">{detail}</p>
        {mayCancel ? (
          <div className="@3xl/main:ml-auto">
            <CancelAnalytics running={sub.status === "active"} />
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

function PlanCard({
  name,
  tag,
  brand,
  current,
  items,
  children,
}: {
  name: string
  tag?: React.ReactNode
  brand?: boolean
  current?: boolean
  items: string[]
  children: React.ReactNode
}) {
  return (
    <section
      aria-label={`${name} plan`}
      className={cn(
        "relative flex min-w-0 flex-col gap-4 overflow-hidden rounded-[14px] border bg-card p-6",
        brand ? "border-primary/45" : "border-border"
      )}
    >
      {/* The plan card's stripe (R4): on the Analytics card only. */}
      {brand ? <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-[image:var(--gradient-brand)]" /> : null}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[1.25rem] font-bold">{name}</h2>
        {current ? <Badge variant="outline">Current plan</Badge> : tag}
      </div>
      {children}
      <ul className="flex flex-1 flex-col gap-2.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[0.84375rem]">
            <IconCheck aria-hidden className={cn("mt-0.5 size-4 shrink-0", brand ? "text-primary" : "text-success")} />
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
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
          <thead>
            <tr className="text-left text-[0.75rem] text-faint-foreground">
              <th className="pb-2 font-medium">Date</th>
              <th className="pb-2 font-medium">For</th>
              <th className="pb-2 font-medium">Reference</th>
              <th className="pb-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {view.payments.map((p, i) => (
              <tr key={i} className="border-t border-border">
                <td className="py-2">{day(p.at)}</td>
                <td className="py-2">{p.label}</td>
                <td className="py-2 font-mono text-[0.75rem] text-muted-foreground">{p.reference ?? "—"}</td>
                <td className="py-2 text-right tabular-nums">{rupees(p.amountMinor / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
