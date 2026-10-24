import { Suspense } from "react"
import { notFound, redirect } from "next/navigation"

import { DateRangeControl } from "@/components/date-range-control"
import { PageHeader } from "@/components/dashboard/page-header"
import { venueTitleFor } from "@/lib/dashboard-record-titles"
import { BuildingOccupancyPanel } from "@/components/dashboard/building-occupancy-panel"
import Link from "next/link"

import { KpiStrip, Locked, Panel, ProTag } from "@/components/dashboard/kit"
import { OfferPreview, PreClaimFigures, VenueInsightBody, VenueProSample } from "@/components/dashboard/venue-insights-panels"
import { Button } from "@/components/ui/button"
import { OrgAnalyticsGrantControl } from "@/app/dashboard/organisations/analytics-grant-control"
import { liveGrantAndPaid } from "@/lib/entitlements"
import { SAMPLE_PRE_CLAIM, SAMPLE_VENUE_INSIGHTS, SAMPLE_VENUE_OFFERS } from "@/lib/sample-analytics"
import { venueInsights, type VenueInsightsView } from "@/lib/venue-insights"
import { venueOffersView, type VenueOffersView } from "@/lib/offers/venue"
import { REGULAR_NIGHTS, REGULAR_WINDOW_DAYS } from "@/lib/regulars"
import { MIN_CELL } from "@/lib/disclosure"
import { maySendVenueOffers } from "@/lib/rbac"
import { OfferComposer } from "./offer-composer"
import { EndOfferButton } from "./end-offer-button"
import { RatingBars } from "@/components/dashboard/primitives"
import { organisationOptions } from "@/lib/onboarding-actions"
import { OpenOnBlendn } from "./open-on-blendn"
import { VenueManage } from "./venue-manage"
import { VenueEventsTable, type VenueEventRow } from "./venue-events-table"
import { getAuth } from "@/lib/auth"
import { getBuildingOccupancy } from "@/lib/building-occupancy"
import { db } from "@/lib/db"
import { discloseStarsAcross, discloseVenueCounts, spreadsByEvent } from "@/lib/disclosure"
import { stillArriving } from "@/lib/occurrences"
import { claimedWindow, hostsEvent } from "@/lib/event-visibility"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { rsvpCounts } from "@/lib/event-tallies"
import { turnUpPct } from "@/lib/counting"
import { formatNumber, formatPct } from "@/lib/dashboard-format"
import { resolveRange } from "@/lib/date-range"
import { activeMembership, actorFor } from "@/lib/org-membership"
import { venueTypeLabel } from "@/lib/venue-types"
import { realEventsWhere } from "@/lib/event-kind"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: (await venueTitleFor((await params).id)) ?? "Venue" }
}

/**
 * One venue.
 *
 * `/dashboard/venues` shows a section per venue but there was no way in. A
 * venue owner with eight rooms needs a page per room — what runs there, who
 * runs it, and whether it is worth keeping — and an admin needs the same page
 * plus who owns it.
 *
 * Access is ownership-shaped, not role-shaped: whoever's organisation owns the
 * venue, plus platform admins. An unclaimed venue is also open to the
 * organisation that added it (owner's ruling 2, SCRUM-352) — but only its
 * record: the events held there belong to their organisers, and the history is
 * nobody's until a claim (ruling 1), so that view stops at the record
 * (SCRUM-361).
 */
export default async function VenueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ range?: string; from?: string; to?: string }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")

  const { id } = await params
  const range = resolveRange(await searchParams)

  /*
   * Retired venues load here, and nowhere else.
   *
   * Every other read filters `deleted_at: null` and should — a retired venue is
   * gone from the feed, the search and the pickers. But this is the screen the
   * restore control lives on, so filtering it here would make retirement
   * one-way by accident: the row would exist, be correct, and be unreachable.
   */
  const venue = await db.venues.findUnique({
    where: { id },
    select: {
      id: true,
      updated_at: true,
      name: true,
      address: true,
      city: true,
      capacity: true,
      status: true,
      claimed_at: true,
      deleted_at: true,
      latitude: true,
      longitude: true,
      venue_type: true,
      geofence: true,
      floors: true,
      open_on_blendn: true,
      created_by_org_id: true,
      owner_org: { select: { id: true, display_name: true } },
    },
  })
  if (!venue) notFound()

  const isAdmin = session.user.role === "app_admin"
  const memberOf = (orgId: string) =>
    db.organisation_members.findFirst({
      where: { user_id: session.user.id, org_id: orgId, ...activeMembership },
      select: { id: true, role: true },
    })
  const record = {
    id: venue.id,
    name: venue.name,
    venueType: venue.venue_type,
    address: venue.address,
    city: venue.city,
    capacity: venue.capacity,
    lat: venue.latitude,
    lng: venue.longitude,
    geofence: venue.geofence,
    retired: venue.deleted_at !== null,
    ownerOrg: venue.owner_org?.display_name ?? null,
    floors: venue.floors,
  }

  const ownerMember = venue.owner_org && !isAdmin ? await memberOf(venue.owner_org.id) : null
  if (!isAdmin && !ownerMember) {
    // Not the owner: the organisation that added it may correct the place
    // while nobody has claimed it, and sees nothing else (SCRUM-361).
    const creator =
      !venue.owner_org && !venue.deleted_at && venue.created_by_org_id
        ? await memberOf(venue.created_by_org_id)
        : null
    if (!creator) redirect("/dashboard/venues")
    return (
      <div className="flex flex-col gap-5">
        {/* No date range: this view has no numbers. */}
        <VenueHeader
          name={venue.name}
          meta={[venueTypeLabel(venue.venue_type), venue.city, "unclaimed — added by your organisation"]
            .filter(Boolean)
            .join(" · ")}
          line="You can correct this place until someone claims it. The events held here stay with the organisers who hold them."
        />
        <VenueManage
          key={venue.updated_at.toISOString()}
          orgs={{ rows: [], total: 0 }}
          venue={record}
          isAdmin={false}
          canRetire={false}
        />
      </div>
    )
  }

  /*
   * The owner sees the venue from its claim on, and an admin sees all of it
   * (SCRUM-355, SCRUM-500). Events, ratings and the live count read through
   * the same window; no claim date on an owned venue is bad data and shows no
   * history at all. `undefined` is the admin's "no window".
   */
  const since = isAdmin ? undefined : claimedWindow(venue)
  const inRange = isAdmin
    ? { gte: range.from, lt: range.to }
    : claimedWindow(venue, { from: range.from, to: range.to })
  const actor = isAdmin ? null : await actorFor(session.user)

  const building = await getBuildingOccupancy(id, { asOwner: actor })

  /*
   * Only fetched when it can be used: an admin, looking at a venue nobody owns.
   * Loading the directory to render a control that will not be shown is the
   * kind of cost that is invisible until the directory is large.
   */
  const ownerOptions =
    isAdmin && !venue.owner_org && !venue.deleted_at
      ? await organisationOptions()
      : { rows: [], total: 0 }

  // The venue's own insights by its plan, and an admin's view of that plan.
  // Nothing paid is computed unless the venue holds Venue Pro (lib/venue-insights.ts).
  // Regulars & offers: counts, and the regulars who said yes; null without Venue Pro (lib/offers/venue.ts).
  const [insights, proRows, offers] = await Promise.all([
    venue.owner_org && !venue.deleted_at ? venueInsights(id) : null,
    isAdmin && venue.owner_org ? liveGrantAndPaid({ kind: "venue", id }, "venue_pro") : null,
    venue.owner_org && !venue.deleted_at ? venueOffersView(id, session.user) : null,
  ])

  const [events, ratingRows] = await Promise.all([
    db.events.findMany({
      // The nights hosts ran here. The venue's own daily live rooms are not
      // among them; what happens in those reaches the owner as aggregates only.
      where: inRange ? { venue_id: id, deleted_at: null, ...realEventsWhere, start_time: inRange } : { id: { in: [] } },
      orderBy: { start_time: "desc" },
      take: 200,
      select: {
        id: true,
        title: true,
        start_time: true,
        end_time: true,
        status: true,
        max_capacity: true,
        organizer_id: true,
        organizer_org_id: true,
        organizer_org: { select: { display_name: true } },
        organizer: { select: { name: true } },
      },
    }),
    // Per event, so the total pools only events that could show their own.
    db.event_ratings.groupBy({
      by: ["event_id", "rating"],
      where:
        since === null
          ? { id: { in: [] } }
          : { event: { venue_id: id, deleted_at: null, ...realEventsWhere, ...(since ? { start_time: since } : {}) } },
      _count: { _all: true },
    }),
  ])

  // Withheld under five raters, and pooled only from events that pass alone,
  // like every rating a host sees (SCRUM-437).
  const { ratings, averageRating, ratingCount: ratingTotal } = discloseStarsAcross(spreadsByEvent(ratingRows))

  /*
   * Attendance is a grouped query, not a `_count`: the table holds one row per
   * person **per day**, so a venue hosting one three-day conference reported
   * three times the people who came through its doors — on the page a venue
   * owner reads for licensing and staffing.
   */
  const [attended, going] = await Promise.all([distinctAttendeeCounts(events.map((e) => e.id)), rsvpCounts(events.map((e) => e.id))])

  const rows: VenueEventRow[] = events.map((e) => {
    const exact = {
      going: going.get(e.id) ?? 0,
      attended: attended.get(e.id) ?? 0,
      fillPct: e.max_capacity ? Math.round(((going.get(e.id) ?? 0) / e.max_capacity) * 100) : null,
    }
    return {
      id: e.id,
      title: e.title,
      startAt: e.start_time.toISOString(),
      status: e.status,
      // The organising company, falling back to whoever created it — an event
      // predating organisations has no org.
      organiser: e.organizer_org?.display_name ?? e.organizer?.name ?? "—",
      // Another host's night, seen as the venue: counts held back under the
      // floor, by the rule the Events list and the exports use (SCRUM-501).
      ...(actor && !hostsEvent(actor, e)
        ? discloseVenueCounts({ ...exact, capacity: e.max_capacity, arriving: stillArriving(e) })
        : exact),
    }
  })

  /*
   * The tiles add up only what the rows show. A total over every night would
   * hand back a held-back one by subtraction — the sum minus the visible
   * cells — so a night with a blank cell is out of both sides of turn-up.
   */
  const shown = rows.filter(
    (r): r is VenueEventRow & { going: number; attended: number } => r.going !== null && r.attended !== null
  )
  const heldBack = shown.length < rows.length
  // Every night held back: no figure to add up, and "0" would say nobody came.
  const nothingShown = heldBack && shown.length === 0
  const totalAttended = shown.reduce((sum, r) => sum + r.attended, 0)
  const totalGoing = shown.reduce((sum, r) => sum + r.going, 0)
  // Uncapped, now that attendance counts people. The cap was framed as absorbing
  // walk-ins and in practice absorbed the row inflation, which hid them.
  const turnUp = turnUpPct(totalAttended, totalGoing)

  const repeatOrganisers = new Map<string, number>()
  for (const r of rows) repeatOrganisers.set(r.organiser, (repeatOrganisers.get(r.organiser) ?? 0) + 1)
  const returning = [...repeatOrganisers.values()].filter((n) => n > 1).length


  // One title line. Status, capacity and owner are words beside the name —
  // none is an action, so none is a chip.
  const titleMeta = [
    venue.deleted_at ? "retired" : venue.status,
    venue.capacity ? `${formatNumber(venue.capacity)} capacity` : null,
    venue.claimed_at
      ? isAdmin && venue.owner_org
        ? venue.owner_org.display_name
        : null
      : // Only an admin ever sees an unclaimed venue, so this is a prompt to
        // act rather than a status nobody can change.
        "unclaimed",
  ].filter(Boolean)
  // The address line without the city repeated: "12th Main Rd, Bengaluru,
  // Bengaluru" is what the seed produces and what an owner types.
  const address =
    venue.address && venue.city && venue.address.endsWith(venue.city)
      ? venue.address
      : [venue.address, venue.city].filter(Boolean).join(" · ")

  return (
    <div className="flex flex-col gap-5">
      <VenueHeader name={venue.name} meta={titleMeta.join(" · ")} line={address || "No address recorded"} ranged />

      {/* Above the window metrics, deliberately: everything below is about a
          date range someone chose, and this is about right now. */}
      <BuildingOccupancyPanel occupancy={building} />

      <KpiStrip
        items={[
          { label: "Events", value: formatNumber(rows.length), hint: "in this window" },
          {
            label: "Attended",
            value: formatNumber(nothingShown ? null : totalAttended),
            hint: heldBack ? "GPS check-ins · held-back nights left out" : "GPS check-ins",
          },
          {
            label: "Turn-up",
            value: turnUp === null ? null : formatPct(turnUp),
            hint: nothingShown ? "held back" : turnUp === null ? "needs a past event" : "of committed RSVPs",
          },
          {
            label: "Returning organisers",
            value: returning,
            hint: returning === 0 ? "nobody has come back yet" : "booked here more than once",
          },
        ]}
      />

      <div className="grid gap-5 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @3xl/main:items-start">
        <Panel title="Events here" hint={rows.length ? `${rows.length} in window` : undefined} bodyClassName="px-4 pb-4 pt-3">
          <VenueEventsTable rows={rows} />
        </Panel>
        <Panel title="Ratings" hint={averageRating === null ? "all-time" : `avg ${averageRating} · all-time`}>
          {ratingTotal === 0 ? (
            <p className="text-[0.8125rem] text-muted-foreground">Nobody has rated an event here yet.</p>
          ) : averageRating === null ? (
            <p className="text-[0.8125rem] text-muted-foreground">Not enough ratings yet.</p>
          ) : (
            <RatingBars counts={ratings} />
          )}
        </Panel>
      </div>

      {insights ? (
        <VenueInsights
          insights={insights}
          isAdmin={isAdmin}
          venueId={venue.id}
          venueName={venue.name}
          offers={offers}
          mayCompose={!!ownerMember && maySendVenueOffers(session.user.role, ownerMember.role)}
        />
      ) : null}

      {isAdmin && venue.owner_org && proRows ? (
        <Panel title="Venue Pro" hint="founding grant: 3 months per claimed Bengaluru venue">
          <OrgAnalyticsGrantControl
            subject="venue"
            subjectId={venue.id}
            name={venue.name}
            status={venue.deleted_at ? "suspended" : "active"}
            grant={proRows.grant ? { expiresAt: proRows.grant.expiresAt?.toISOString() ?? null } : null}
            paid={proRows.paid ? { id: proRows.paid.id, expiresAt: proRows.paid.expiresAt?.toISOString() ?? null } : null}
          />
        </Panel>
      ) : null}

      {/* Only a claimed venue has an owner to opt out (D-13); an unclaimed one is always listed. */}
      {venue.owner_org && !venue.deleted_at ? (
        <OpenOnBlendn venueId={venue.id} name={venue.name} open={venue.open_on_blendn} />
      ) : null}

      {/* The record last. "Is the pin right" is the third question a venue
          owner asks of this page, after "how busy" and "who books here" — and
          it used to be the first block, a form above every number. */}
      <VenueManage
        // Remount on every saved change, so the fields show what was stored
        // rather than what was typed — router.refresh() alone left a form
        // seeded once at mount showing the pre-save value.
        key={venue.updated_at.toISOString()}
        orgs={ownerOptions}
        venue={record}
        isAdmin={isAdmin}
      />
    </div>
  )
}

const SINCE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })

/**
 * The venue's insights by plan (plan v2 §9.1b): Listed sees 30 days; Venue
 * Pro a year, and the nights before the claim as three totals. What Pro adds
 * is previewed from the static sample, never this venue's figures. Regulars &
 * offers (step 12) is Venue Pro: the real panel with Pro, the sample's preview
 * without it.
 */
function VenueInsights({
  insights,
  isAdmin,
  venueId,
  venueName,
  offers,
  mayCompose,
}: {
  insights: VenueInsightsView
  isAdmin: boolean
  venueId: string
  venueName: string
  offers: VenueOffersView | null
  mayCompose: boolean
}) {
  const pro = insights.plan === "pro"
  const toPlan = isAdmin ? null : (
    <Button asChild size="sm" variant="outline">
      <Link href="/dashboard/plan">See Venue Pro</Link>
    </Button>
  )
  return (
    <>
      <Panel
        title="Who comes, and when"
        // Whole nights: the window ends where today began, so the figures move once a day.
        hint={`${pro ? "last 12 months" : "last 30 days"} · ${SINCE.format(new Date(insights.recent.from))} – ${SINCE.format(new Date(insights.recent.to))} · guests only, never who`}
        action={pro ? <ProTag plan="Venue Pro" /> : <span className="text-[0.75rem] text-faint-foreground">Listed</span>}
      >
        <VenueInsightBody insight={insights.recent} />
      </Panel>

      {pro && insights.preClaim ? (
        <Panel title="Before you claimed it" hint="totals only: the nights held here before your claim stay closed">
          <PreClaimFigures history={insights.preClaim} />
        </Panel>
      ) : !pro ? (
        <Locked
          plan="Venue Pro"
          title="A year of guests, and the venue's past"
          body="Venue Pro shows 12 months, and the nights held here before your claim as totals — never the people."
          action={toPlan}
          height={300}
          sample={<VenueProSample insight={SAMPLE_VENUE_INSIGHTS} history={SAMPLE_PRE_CLAIM} />}
        />
      ) : null}

      {offers ? (
        <RegularsOffers offers={offers} venueId={venueId} venueName={venueName} mayCompose={mayCompose} isAdmin={isAdmin} />
      ) : (
        <Locked
          plan="Venue Pro"
          title="Regulars & offers"
          body="Send an offer to the people who keep coming back. They get it in the app; you see sent, opened and redeemed, never who."
          action={toPlan}
          height={200}
          sample={<OfferPreview offer={SAMPLE_VENUE_OFFERS} />}
        />
      )}
    </>
  )
}

const OFFER_DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
const NEXT_AT = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })

/**
 * Regulars & offers, for a venue on Venue Pro (step 12). The composer for
 * its owners and admins; each offer with how many it went to; what they did
 * as totals across offers, up to this morning (lib/offers/venue.ts says why
 * never per offer, never live); and the regulars who chose to let it know
 * them — by first name, from their own yes.
 */
function RegularsOffers({
  offers,
  venueId,
  venueName,
  mayCompose,
  isAdmin,
}: {
  offers: VenueOffersView
  venueId: string
  venueName: string
  mayCompose: boolean
  isAdmin: boolean
}) {
  return (
    <Panel
      title="Regulars & offers"
      hint={`${offers.sentThisWeek} of ${offers.perWeek} this week · counts, never who`}
      action={<ProTag plan="Venue Pro" />}
    >
      <div className="grid gap-5 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @3xl/main:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          {mayCompose ? (
            offers.nextAt ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                {offers.perWeek} offers a week. The next can go {NEXT_AT.format(new Date(offers.nextAt))}.
              </p>
            ) : (
              <OfferComposer venueId={venueId} />
            )
          ) : null}
          <p id="offer-rule" className="text-[0.8125rem] text-muted-foreground">
            An offer goes to people who came on {REGULAR_NIGHTS}+ nights in the last {REGULAR_WINDOW_DAYS}. Under {MIN_CELL}, nothing
            is sent. You see how many — never who.
          </p>
          {offers.offers.length === 0 ? (
            <p className="text-[0.8125rem] text-muted-foreground">No offers sent yet.</p>
          ) : (
            <>
              <dl className="grid grid-cols-3 gap-3 border-t border-border pt-3">
                {(
                  [
                    ["Sent", offers.totals.sent],
                    ["Opened", offers.totals.opened === null ? null : formatNumber(offers.totals.opened)],
                    ["Redeemed", offers.totals.redeemed === null ? null : formatNumber(offers.totals.redeemed)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <dt className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
                    <dd className={value === null ? "text-[0.8125rem] text-faint-foreground" : "text-[1.375rem] font-bold tabular-nums"}>
                      {value === null ? "held back" : value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-[0.75rem] text-faint-foreground">
                {offers.totals.asOf
                  ? `All your offers here, as of the week starting ${OFFER_DAY.format(new Date(offers.totals.asOf))}: weekly totals, never per offer or per person.`
                  : "Totals appear once a week has enough in it to show without pointing at anyone."}
              </p>
              <table className="w-full text-[0.8125rem]">
                <caption className="sr-only">Offers sent</caption>
                <thead>
                  <tr className="text-[0.6875rem] uppercase tracking-[0.06em] text-muted-foreground">
                    <th scope="col" className="py-2 text-left font-medium">Offer</th>
                    <th scope="col" className="w-16 py-2 text-right font-medium">To</th>
                    {isAdmin ? <th scope="col" className="w-20 py-2 text-right font-medium"><span className="sr-only">End</span></th> : null}
                  </tr>
                </thead>
                <tbody>
                  {offers.offers.map((o) => (
                    <tr key={o.id} className="border-t border-border align-middle">
                      <td className="py-3 pr-3">
                        <span className="block">{o.text}</span>
                        <span className="text-[0.75rem] text-faint-foreground">
                          {OFFER_DAY.format(new Date(o.createdAt))} · {o.live ? `live until ${OFFER_DAY.format(new Date(o.endsAt))}` : "ended"}
                        </span>
                      </td>
                      <td className="py-3 text-right font-bold tabular-nums">{o.reached ?? "—"}</td>
                      {isAdmin ? (
                        <td className="py-3 text-right">{o.live ? <EndOfferButton offerId={o.id} /> : null}</td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <span className="text-[0.75rem] text-muted-foreground">They let you know</span>
          {offers.known.length === 0 ? (
            <p className="text-[0.8125rem] text-muted-foreground">Nobody yet. Anyone can choose to let {venueName} know they&apos;re a regular, in the app.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {offers.known.map((k, i) => (
                <li key={`${k.firstName}-${i}`} className="rounded-full border border-border px-2.5 py-1 text-[0.8125rem]">
                  <b className="font-semibold">{k.firstName}</b> · {k.nights} {k.nights === 1 ? "night" : "nights"}
                </li>
              ))}
            </ul>
          )}
          {offers.known.length > 0 ? (
            <p className="text-[0.8125rem] text-muted-foreground">
              People who chose &ldquo;Let {venueName} know I&apos;m a regular&rdquo; in the app. They can take it back any time.
            </p>
          ) : null}
          {!isAdmin ? (
            <Link href={`/dashboard/venues/${venueId}/door`} className="text-[0.8125rem] underline underline-offset-4">
              Redeem a pass at the door →
            </Link>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

/**
 * The venue's own header (`OWNED_HEADERS`), for both views of this page. The
 * owner's view carries the date range — this is one of the three routes whose
 * numbers read it (`showsRange`) — and the adding organisation's does not.
 */
function VenueHeader({
  name,
  meta,
  line,
  ranged = false,
}: {
  name: string
  meta: string
  line: string
  ranged?: boolean
}) {
  return (
    <PageHeader
      title={name}
      description={meta}
      actions={
        ranged ? (
          // useSearchParams needs a Suspense boundary.
          <Suspense fallback={<div className="h-9 w-[250px]" />}>
            <DateRangeControl />
          </Suspense>
        ) : undefined
      }
    >
      <p className="text-[0.8125rem] text-muted-foreground">{line}</p>
    </PageHeader>
  )
}
