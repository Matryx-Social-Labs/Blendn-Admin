import Link from "next/link"
import { redirect } from "next/navigation"
import { IconBuilding } from "@tabler/icons-react"

import { EventPassPanels, OrgPanels } from "@/components/dashboard/analytics-panels"
import { Locked, Panel, PillTabs } from "@/components/dashboard/kit"
import { EmptyState, HeroMetric } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import { getAuth } from "@/lib/auth"
import { billingOrgFor } from "@/lib/billing"
import { BILLING_PLANS, grossRupees, rupees } from "@/lib/billing-plans"
import { mayReachRoute } from "@/lib/dashboard-nav"
import { routeMetadata } from "@/lib/dashboard-route-content"
import { analyticsPage, parseRange, RANGES, type AnalyticsPageView } from "@/lib/org-analytics"
import { SAMPLE_EVENT_ANALYTICS, SAMPLE_ORG_ANALYTICS } from "@/lib/sample-analytics"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/analytics")

export const dynamic = "force-dynamic"

/**
 * Analytics: only what is new and paid (plan v2 §9.1b, audit §6.1).
 *
 * Turn-up, no-shows, came-back, connections and ratings per event are free and
 * stay on Overview, Attendees and each event's page; nothing here repeats them.
 *
 * Everything the page shows comes from one call, `analyticsPage`, which
 * computes no paid figure the organisation may not see. A locked view is
 * `Locked` around the static sample (`lib/sample-analytics.ts`), never the
 * organisation's numbers under a blur (MN-I12; the owner's ruling).
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
const day = (iso: string) => DAY.format(new Date(iso))
const RANGE_LABEL = { "30d": "30 days", "90d": "90 days", all: "All time" } as const

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; event?: string }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (!mayReachRoute(session.user.role, "/dashboard/analytics")) redirect("/dashboard")

  const org = await billingOrgFor({ id: session.user.id, role: session.user.role })
  if (!org) {
    return (
      <EmptyState
        icon={<IconBuilding />}
        title="No organisation yet"
        description="Analytics belongs to an organisation. Once you're part of one, its numbers are here."
      />
    )
  }

  const params = await searchParams
  const view = await analyticsPage(org.orgId, { range: parseRange(params.range), eventId: params.event })
  const pass = rupees(grossRupees(BILLING_PLANS.event_pass))

  return (
    <>
      <AccessLine view={view} />

      {view.org ? (
        <>
          <PillTabs
            label="Range"
            active={view.range}
            tabs={RANGES.map((r) => ({ key: r, label: RANGE_LABEL[r], href: `/dashboard/analytics?range=${r}` }))}
          />
          <HeroMetric
            eyebrow="Came back within 90 days"
            value={view.org.backWithin90.pct === null ? "Held back" : `${view.org.backWithin90.pct}%`}
            unit={view.org.backWithin90.cohort === null ? undefined : `of ${view.org.backWithin90.cohort} first-timers`}
            description={
              view.org.backWithin90.pct === null
                ? "Shown once at least 5 people's first event here was 90 days ago or more, and the share that came back is not everyone or nearly everyone."
                : "People whose first event here was at least 90 days ago and who came to another within 90 days."
            }
          />
          <OrgPanels data={view.org} />
        </>
      ) : (
        <Locked
          height={420}
          title="Know which nights worked"
          body="Every event side by side, whether first-timers came back, and pacing against your own median. Running events, check-in, the room and each event's turn-up stay free."
          sample={<OrgPanels data={SAMPLE_ORG_ANALYTICS} />}
          action={
            <Button asChild size="sm">
              <Link href="/dashboard/plan">See plans</Link>
            </Button>
          }
        />
      )}

      <EventSection view={view} pass={pass} />
    </>
  )
}

function AccessLine({ view }: { view: AnalyticsPageView }) {
  const { access } = view
  const first = access.firstFreeEvent
  let headline: string
  let detail: string
  if (access.reason === "grant") {
    headline = access.paidUntil ? `Founding grant until ${day(access.paidUntil)}` : "Founding grant"
    detail = "Blend'n has given your organisation Analytics. Nothing is charged."
  } else if (access.reason === "analytics") {
    headline = access.paidUntil ? `Analytics until ${day(access.paidUntil)}` : "Analytics"
    detail = "Every view, for every event."
  } else if (access.reason === "free_window" && access.freeUntil && first) {
    headline = `Free until ${day(access.freeUntil)}`
    detail = `Your first event that cleared the privacy floor, ${first.title}, ended ${day(first.endedAt)}. Everything here is open until 30 days after it; that event stays open for good.`
  } else if (access.reason === "free_window") {
    headline = "Free for now"
    detail = "Everything here is open until 30 days after your first event with at least 5 people checked in."
  } else {
    headline = "Free plan"
    detail = first
      ? `${first.title} stays open for good. An Event Pass opens another event; Analytics opens everything.`
      : "An Event Pass opens one event; Analytics opens everything."
  }
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" role="status">
        <p className="text-[0.9375rem] font-bold">{headline}</p>
        <p className="text-[0.8125rem] text-muted-foreground">{detail}</p>
        {access.reason === "free" ? (
          <Link href="/dashboard/plan" className="text-[0.8125rem] font-medium text-primary underline-offset-4 hover:underline @3xl/main:ml-auto">
            See plans
          </Link>
        ) : null}
      </div>
    </Panel>
  )
}

function EventSection({ view, pass }: { view: AnalyticsPageView; pass: string }) {
  const selected = view.selected
  if (!selected) {
    return (
      <Panel title="One event">
        <p className="text-[0.8125rem] text-muted-foreground">
          How long people stayed, when they arrived and whether views turned into RSVPs appear here once an event has run.
        </p>
      </Panel>
    )
  }
  const isFirstFree = view.access.firstFreeEvent?.id === selected.id
  const picker = (
    // A GET form, so choosing an event works without JavaScript and is a URL.
    <form method="get" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="range" value={view.range} />
      <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[0.75rem] text-muted-foreground">
        Event
        <select
          name="event"
          defaultValue={selected.id}
          className="h-9 rounded-md border border-input bg-background px-2 text-[0.8125rem] text-foreground"
        >
          {view.events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title} · {day(e.startsAt)}
              {e.open ? "" : " (locked)"}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="outline" size="sm">
        Show
      </Button>
    </form>
  )
  const hint = `${day(selected.startsAt)}${isFirstFree && !view.access.org ? " · free for good: your first event that cleared the floor" : ""}`

  if (selected.data) {
    return (
      <Panel title={selected.title} hint={hint}>
        {picker}
        <EventPassPanels data={selected.data} />
      </Panel>
    )
  }
  // Locked: the preview sits beside the panel, never inside it (R3, no card in a card).
  return (
    <>
      <Panel title={selected.title} hint={hint}>
        {picker}
      </Panel>
      <Locked
        height={280}
        title="See how this night went"
        body={`How long people stayed, when they arrived, first-time vs returning, and app views → RSVPs. ${pass} for this event, or Analytics for every event.`}
        sample={<EventPassPanels data={SAMPLE_EVENT_ANALYTICS} />}
        action={
          <Button asChild size="sm">
            <Link href="/dashboard/plan">See plans</Link>
          </Button>
        }
      />
    </>
  )
}
