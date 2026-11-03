import Link from "next/link"
import { redirect } from "next/navigation"
import { formatInTimeZone } from "date-fns-tz"

import { EventHeader } from "@/components/dashboard/event-header"
import { Panel } from "@/components/dashboard/kit"
import { HeroMetric } from "@/components/dashboard/primitives"
import { db } from "@/lib/db"
import { eventTitleFor } from "@/lib/dashboard-record-titles"
import { eventClock } from "@/lib/event-phase"
import { latestLegalAcceptance, ORGANIZER_TICKETING_TERMS } from "@/lib/legal-acceptance"
import { readOrganizerTicketingTerms } from "@/lib/legal-html"
import { loadEventPage } from "@/lib/event-page"
import { formatCount, formatMinor } from "@/lib/money"
import { activeMembership } from "@/lib/org-membership"
import { payoutSubmittedAt } from "@/lib/payout-account"
import { payoutStatus } from "@/lib/payout-status"
import { FOUNDING_OFFER_ENDS_AT, FOUNDING_OFFER_EVENTS, parseFeeSchedule } from "@/lib/ticket-fees"
import { SALES_PAGE_SIZE, salesPage, ticketsSummary, type SalesStatusFilter } from "@/lib/ticket-sales"
import { feePreview, marketFor } from "@/lib/ticket-setup"
import { MAX_PER_ORDER_CAP, TICKET_TYPES_MAX } from "@/lib/ticket-types"
import { cn } from "@/lib/utils"

import { ExternalLinkForm } from "./external-link"
import { RefundButton } from "./refund-button"
import { DimStep, PayoutStep, TurnOnForm } from "./setup"
import { TypesPanel, type TypeRow } from "./types-panel"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const name = await eventTitleFor((await params).id)
  return { title: name ? `Tickets · ${name}` : "Tickets" }
}

/** The ₹999 ticket the fee preview prices (mockup state 2). */
const EXAMPLE_MINOR = 99_900
const COUNTRY: Record<string, string> = { CA: "Canada", IN: "India" }

/**
 * The event's Tickets tab (SCRUM-1014): turn tickets on, sell, refund, and
 * know when the money lands, without leaving the event. D-A "one page, money
 * first", built to `tickets-tab-20261102/finalized.html`.
 *
 * Offered by `eventTabsFor` to whoever may edit the event (`canEdit`), for an
 * event whose market sells (`TICKETING` on, `loadEventPage`'s `ticketing`);
 * asked again here, because a URL is not a tab list. The door is its own page
 * (`./door`), canOperate's.
 */
export default async function TicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ page?: string; q?: string; type?: string; status?: string }>
}) {
  const { id } = await params
  const data = await loadEventPage(id)
  const { event, actor, permissions, ticketing } = data
  if (!ticketing || !permissions.canEdit || event.kind !== "event") redirect(`/dashboard/events/${id}`)

  const header = <EventHeader data={data} active="tickets" />
  const row = await db.events.findUniqueOrThrow({
    where: { id },
    select: { ticketing_mode: true, external_ticket_url: true, refund_policy: true, fees_absorbed: true, ticket_fee_schedule: true, ticket_fee_rule: true, timezone: true, end_time: true },
  })

  if (ticketing === "external") {
    const market = await marketFor(event.city)
    const country = COUNTRY[market?.code ?? ""] ?? market?.name ?? "this country"
    return (
      <div className="flex flex-col gap-5">
        {header}
        <Panel title="Link to your tickets" hint={`Events in ${country}`}>
          <ExternalLinkForm eventId={id} url={row.external_ticket_url} countryName={country} />
        </Panel>
      </div>
    )
  }

  if (row.ticketing_mode !== "native") {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <Setup eventId={id} orgId={event.organizer_org_id} city={event.city} actor={actor} refundPolicy={row.refund_policy} feesAbsorbed={row.fees_absorbed} />
      </div>
    )
  }

  const sp = await searchParams
  const query = { page: Number(sp.page) || 1, q: sp.q?.slice(0, 40), typeId: sp.type, status: (["paid", "refunded"].includes(sp.status ?? "") ? sp.status : "all") as SalesStatusFilter }
  const [summary, sales, types] = await Promise.all([
    ticketsSummary(id),
    salesPage(actor, id, query),
    db.ticket_types.findMany({ where: { event_id: id }, orderBy: [{ sort: "asc" }, { id: "asc" }] }),
  ])
  if (!sales) redirect(`/dashboard/events/${id}`)
  const schedule = parseFeeSchedule(row.ticket_fee_schedule)
  const currency = schedule.currency
  const clock = eventClock(row.timezone)
  const money = (m: number) => formatMinor(m, currency)
  const day = (d: Date) => clock.format(d, { weekday: "short", day: "numeric", month: "short" })
  const now = new Date()

  const typeRows: TypeRow[] = types.map((t) => ({
    id: t.id,
    name: t.name,
    priceMinor: t.price_minor,
    quantity: t.quantity,
    sold: t.sold,
    held: t.held,
    maxPerOrder: t.max_per_order,
    hidden: t.hidden,
    windowLabel: t.hidden ? "—" : windowLabel(t.sale_starts_at, t.sale_ends_at, row.end_time, now, clock),
    startsLocal: t.sale_starts_at ? formatInTimeZone(t.sale_starts_at, clock.zone, "yyyy-MM-dd'T'HH:mm") : "",
    endsLocal: t.sale_ends_at ? formatInTimeZone(t.sale_ends_at, clock.zone, "yyyy-MM-dd'T'HH:mm") : "",
  }))
  const paidTicketsBefore = types.reduce((n, t) => n + t.sold, 0)

  return (
    <div className="flex flex-col gap-5">
      {header}
      <MoneyHero summary={summary} money={money} day={day} feesAbsorbed={row.fees_absorbed} />
      <TypesPanel
        eventId={id}
        types={typeRows}
        max={TICKET_TYPES_MAX}
        maxPerOrderCap={MAX_PER_ORDER_CAP}
        currency={currency}
        schedule={schedule}
        rule={row.ticket_fee_rule ?? "standard"}
        feesAbsorbed={row.fees_absorbed}
        paidTicketsBefore={paidTicketsBefore}
        startEditing={types.length === 0}
      />
      <SalesPanel eventId={id} sales={sales} query={query} types={types} feesAbsorbed={row.fees_absorbed} format={(d) => clock.format(d, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} />
      <div className="grid grid-cols-1 items-start gap-5 @4xl/main:grid-cols-2">
        <Panel title="Payout" hint="One per event, released 3 days after it ends">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className="py-2.5 pr-3">Ticket sales ({formatCount(summary.soldTickets + summary.refundedTickets)})</td>
                <td className="py-2.5 text-right tabular-nums">{formatMinor(summary.grossMinor, currency, { paise: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className="py-2.5 pr-3">Refunds ({formatCount(summary.refundedTickets)} tickets)</td>
                <td className="py-2.5 text-right tabular-nums">−{formatMinor(summary.refundedMinor, currency, { paise: true })}</td>
              </tr>
              <tr>
                <td className="py-2.5 pr-3 font-bold">Your payout</td>
                <td className="py-2.5 text-right font-bold tabular-nums">{formatMinor(summary.payoutMinor, currency, { paise: true })}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-[0.8125rem] text-faint-foreground">
            {row.fees_absorbed ? "You absorb the booking fees; they are already taken out of this figure." : "Buyers paid the booking fees; they are not in this figure."}
          </p>
        </Panel>
        <Panel title="Refunds" hint={summary.refundedOrders ? `${summary.refundedTickets} tickets in ${summary.refundedOrders} orders` : undefined}>
          {summary.refunds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No refunds.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[0.75rem] text-faint-foreground">
                    <th className="py-2 pr-3 font-medium">Order</th>
                    <th className="py-2 pr-3 text-right font-medium">Amount</th>
                    <th className="py-2 pr-3 font-medium">Refunded</th>
                    <th className="py-2 font-medium">By</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.refunds.map((r) => (
                    <tr key={r.ref} className="border-b border-border last:border-0">
                      <td className="py-2.5 pr-3 font-mono text-[0.8125rem]">{r.ref}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{formatMinor(r.amountMinor, currency, { paise: true })}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{r.refundedAt ? clock.day(r.refundedAt) : "Refunding"}</td>
                      <td className="py-2.5 text-muted-foreground">{r.by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[0.8125rem] text-faint-foreground">Razorpay returns the money to the buyer in 5–7 days.</p>
        </Panel>
      </div>
      <p className="text-[0.8125rem] text-muted-foreground">
        Canceling the event refunds every buyer in full, booking fee included. That is{" "}
        <Link className="underline underline-offset-[3px]" href={`/dashboard/events/${id}/edit`}>
          Edit event
        </Link>{" "}
        → Cancel event.
      </p>
    </div>
  )
}

function windowLabel(starts: Date | null, ends: Date | null, eventEnd: Date, now: Date, clock: ReturnType<typeof eventClock>): string {
  const at = (d: Date) => clock.format(d, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
  const close = ends ?? eventEnd
  if (close <= now) return `Ended ${clock.format(close, { weekday: "short", day: "numeric", month: "short" })}`
  if (starts && starts > now) return `From ${at(starts)}`
  return ends ? `Until ${at(ends)}` : "Until the event ends"
}

/** The hero and the memorable detail: Sold → On hold → Released, the release date the only bright word. */
function MoneyHero({
  summary: s,
  money,
  day,
  feesAbsorbed,
}: {
  summary: Awaited<ReturnType<typeof ticketsSummary>>
  money: (m: number) => string
  day: (d: Date) => string
  feesAbsorbed: boolean
}) {
  const stage = "relative pt-3.5 pr-4 before:absolute before:inset-x-0 before:top-0 before:h-1 before:bg-surface-raised"
  return (
    <HeroMetric
      eyebrow={s.released ? "Paid out" : "Yours so far"}
      value={money(s.payoutMinor)}
      action={
        <div className="flex flex-col gap-4">
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-[0.8125rem] text-muted-foreground">
            <span>
              <b className="text-foreground tabular-nums">{formatCount(s.soldTickets)}</b> of {formatCount(s.capacity)} tickets
            </span>
            {s.refundedTickets ? (
              <span>
                <b className="text-foreground tabular-nums">{formatCount(s.refundedTickets)}</b> refunded
              </span>
            ) : null}
            {s.released ? (
              <span>
                <b className="text-foreground tabular-nums">{formatCount(s.inside)}</b> came through the door
              </span>
            ) : (
              <span>{feesAbsorbed ? "you absorb the booking fee" : "buyers pay the booking fee"}</span>
            )}
          </p>
          <ol aria-label="Where the money is" className="grid grid-cols-1 gap-3.5 @3xl/main:grid-cols-3 @3xl/main:gap-0">
            <li className={cn(stage, "before:rounded-l-sm before:bg-muted-foreground")}>
              <div className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">Sold</div>
              <div className="mt-1 text-xl font-bold tabular-nums">{money(s.grossMinor)}</div>
              <div className="text-[0.8125rem] text-muted-foreground">
                {formatCount(s.soldTickets + s.refundedTickets)} tickets{s.refundedTickets ? `; ${s.refundedTickets} refunded since` : ""}
              </div>
            </li>
            <li className={cn(stage, s.released ? "before:bg-muted-foreground" : "before:bg-[linear-gradient(90deg,var(--muted-foreground),var(--surface-raised))]")}>
              <div className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">On hold</div>
              <div className="mt-1 text-xl font-bold tabular-nums">{money(s.payoutMinor)}</div>
              <div className="text-[0.8125rem] text-muted-foreground">
                {s.released ? (
                  "until the event had ended"
                ) : (
                  <>
                    in your Razorpay account until <span className="font-bold text-primary">{day(s.releaseAt)}</span>
                  </>
                )}
              </div>
            </li>
            <li className={cn(stage, "before:rounded-r-sm", s.released && "before:bg-muted-foreground")}>
              <div className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">Released</div>
              <div className={cn("mt-1 text-xl font-bold tabular-nums", !s.released && "text-faint-foreground")}>{s.released ? money(s.payoutMinor) : "—"}</div>
              <div className="text-[0.8125rem] text-muted-foreground">
                {s.released ? (
                  <>
                    to your bank on <span className="font-bold text-primary">{day(s.releaseAt)}</span>
                  </>
                ) : (
                  "to your bank, 3 days after the event"
                )}
              </div>
            </li>
          </ol>
        </div>
      }
    />
  )
}

function SalesPanel({
  eventId,
  sales,
  query,
  types,
  feesAbsorbed,
  format,
}: {
  eventId: string
  sales: NonNullable<Awaited<ReturnType<typeof salesPage>>>
  query: { q?: string; typeId?: string; status: SalesStatusFilter }
  types: Array<{ id: string; name: string }>
  feesAbsorbed: boolean
  format: (d: Date) => string
}) {
  const base = `/dashboard/events/${eventId}/tickets`
  const href = (page: number) => {
    const qs = new URLSearchParams()
    if (query.q) qs.set("q", query.q)
    if (query.typeId) qs.set("type", query.typeId)
    if (query.status !== "all") qs.set("status", query.status)
    if (page > 1) qs.set("page", String(page))
    const s = qs.toString()
    return s ? `${base}?${s}#sales` : `${base}#sales`
  }
  const from = sales.total ? (sales.page - 1) * SALES_PAGE_SIZE + 1 : 0
  const to = Math.min(sales.total, sales.page * SALES_PAGE_SIZE)
  const pages = pageList(sales.page, sales.pages)
  const select = "h-8 rounded-md border border-input bg-transparent px-2.5 text-[0.8125rem] dark:bg-input/30 pointer-coarse:h-11"

  return (
    <Panel title={<span id="sales">Sales</span>} hint="Buyers appear as their attendee label, as in Attendees and the exports.">
      <form action={base} className="flex flex-wrap items-center gap-2" role="search" aria-label="Sales">
        <input
          name="q"
          defaultValue={query.q}
          aria-label="Search order or attendee label"
          placeholder="Search order or attendee label"
          className="h-8 w-[300px] max-w-full rounded-md border border-input bg-transparent px-3 text-sm dark:bg-input/30 pointer-coarse:h-11"
        />
        <select name="type" defaultValue={query.typeId ?? ""} aria-label="Ticket type" className={select}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={query.status === "all" ? "" : query.status} aria-label="Status" className={select}>
          <option value="">Paid and refunded</option>
          <option value="paid">Paid</option>
          <option value="refunded">Refunded</option>
        </select>
        <button type="submit" className="h-8 rounded-md border border-border-strong px-3 text-[0.8125rem] font-medium pointer-coarse:h-11">
          Search
        </button>
      </form>
      {sales.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{query.q || query.typeId || query.status !== "all" ? "No orders match." : "No orders yet."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[0.75rem] text-faint-foreground">
                <th className="py-2 pr-3 font-medium">Order</th>
                <th className="hidden py-2 pr-3 font-medium @2xl/main:table-cell">Attendee</th>
                <th className="hidden py-2 pr-3 font-medium @4xl/main:table-cell">Type</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Ticket price</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="hidden py-2 pr-3 font-medium @4xl/main:table-cell">Ordered</th>
                <th className="py-2">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sales.rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-3 font-mono text-[0.8125rem]">{r.ref}</td>
                  <td className="hidden py-2.5 pr-3 font-mono text-[0.8125rem] text-muted-foreground @2xl/main:table-cell">{r.label}</td>
                  <td className="hidden py-2.5 pr-3 @4xl/main:table-cell">{r.types}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{r.quantity}</td>
                  <td className="py-2.5 pr-3 text-right whitespace-nowrap tabular-nums">{formatMinor(r.ticketPriceMinor, sales.currency, { paise: true })}</td>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    {r.status === "paid" ? (
                      <span className="text-[0.8125rem] font-medium text-success">Paid</span>
                    ) : r.status === "refunding" ? (
                      <span className="text-[0.8125rem] font-medium text-warning">Refunding</span>
                    ) : (
                      <span className="text-[0.8125rem] font-medium text-faint-foreground">Refunded{r.refundedAt ? ` ${format(r.refundedAt).split(",")[0]}` : ""}</span>
                    )}
                  </td>
                  <td className="hidden py-2.5 pr-3 whitespace-nowrap text-muted-foreground @4xl/main:table-cell">{format(r.createdAt)}</td>
                  <td className="py-2.5 text-right">
                    {r.refundable ? (
                      <RefundButton
                        eventId={eventId}
                        orderId={r.id}
                        orderRef={r.ref}
                        label={r.label}
                        quantity={r.quantity}
                        types={r.types}
                        refundMinor={r.refundMinor}
                        bookingFeeMinor={r.bookingFeeMinor}
                        feesAbsorbed={feesAbsorbed}
                        currency={sales.currency}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[0.8125rem] text-muted-foreground">
        <span>
          {sales.total ? `Showing ${formatCount(from)}–${formatCount(to)} of ${formatCount(sales.total)} orders` : "0 orders"}
        </span>
        {sales.pages > 1 ? (
          <nav aria-label="Pages" className="flex gap-1">
            <PageLink href={sales.page > 1 ? href(sales.page - 1) : null} label="Previous page">
              ‹
            </PageLink>
            {pages.map((n, i) =>
              n === null ? (
                <span key={`gap-${i}`} className="flex h-[30px] min-w-[30px] items-center justify-center" aria-hidden>
                  …
                </span>
              ) : (
                <PageLink key={n} href={href(n)} current={n === sales.page} label={`Page ${n}`}>
                  {n}
                </PageLink>
              )
            )}
            <PageLink href={sales.page < sales.pages ? href(sales.page + 1) : null} label="Next page">
              ›
            </PageLink>
          </nav>
        ) : null}
      </div>
    </Panel>
  )
}

/** 1 2 3 … 40, with the current page and its neighbours. */
function pageList(page: number, pages: number): Array<number | null> {
  const want = new Set([1, 2, 3, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages))
  const sorted = [...want].sort((a, b) => a - b)
  return sorted.flatMap((n, i) => (i > 0 && n - sorted[i - 1] > 1 ? [null, n] : [n]))
}

function PageLink({ href, current, label, children }: { href: string | null; current?: boolean; label: string; children: React.ReactNode }) {
  const cls = cn(
    "flex h-[30px] min-w-[30px] items-center justify-center rounded-md border border-border px-1.5 text-[0.8125rem] font-medium text-foreground pointer-coarse:size-11",
    current && "border-border-strong bg-accent"
  )
  if (!href) return <span className={cn(cls, "opacity-40")} aria-hidden>{children}</span>
  return (
    <Link href={href} aria-label={label} aria-current={current ? "page" : undefined} className={cls}>
      {children}
    </Link>
  )
}

/** Not selling yet: payouts, then fees, who pays, refunds and the terms. */
async function Setup({
  eventId,
  orgId,
  city,
  actor,
  refundPolicy,
  feesAbsorbed,
}: {
  eventId: string
  orgId: string | null
  city: string | null
  actor: { id: string; role: string }
  refundPolicy: string
  feesAbsorbed: boolean
}) {
  if (!orgId) {
    return (
      <Panel title="Sell tickets for this event">
        <p className="text-sm text-muted-foreground">Ticket selling needs an organization behind the event. Claim it for your organization first.</p>
      </Panel>
    )
  }
  const [org, payout, submittedAt, members, acceptance, market] = await Promise.all([
    db.organisations.findUniqueOrThrow({ where: { id: orgId }, select: { display_name: true, legal_name: true } }),
    payoutStatus(orgId),
    payoutSubmittedAt(orgId),
    db.organisation_members.findMany({ where: { org_id: orgId, role: { in: ["owner", "admin"] }, ...activeMembership }, select: { user_id: true, role: true, user: { select: { name: true } } } }),
    latestLegalAcceptance(orgId, ORGANIZER_TICKETING_TERMS.key),
    marketFor(city),
  ])
  const isAdmin = actor.role === "app_admin"
  // Binding the organization (the terms) is its owners' and admins' alone, as recordLegalAcceptance holds; a Blend'n admin may also enter the payout account.
  const binds = members.some((m) => m.user_id === actor.id)
  const owners = members.filter((m) => m.role === "owner").map((m) => m.user.name ?? "an owner")
  const orgName = org.legal_name ?? org.display_name
  const fmtDay = (d: Date) => eventClock("Asia/Kolkata").format(d, { day: "numeric", month: "short", year: "numeric" })
  const connected = payout?.connected ?? false

  let turnOn: React.ReactNode = null
  if (connected && market) {
    const [preview, accepter] = await Promise.all([
      feePreview(orgId, market, EXAMPLE_MINOR),
      acceptance ? db.user.findUnique({ where: { id: acceptance.userId }, select: { name: true } }) : null,
    ])
    const terms = readOrganizerTicketingTerms()
    const current = acceptance?.version === ORGANIZER_TICKETING_TERMS.version
    turnOn = (
      <TurnOnForm
        eventId={eventId}
        orgName={orgName}
        currency={preview.currency}
        rule={preview.rule}
        foundingUsed={preview.ticketedEventsBefore}
        foundingOfferEvents={FOUNDING_OFFER_EVENTS}
        foundingEnds={fmtDay(new Date(FOUNDING_OFFER_ENDS_AT.getTime() - 1))}
        slabs={preview.slabs}
        minFeeMinor={preview.minFeeMinor}
        taxLabel={preview.taxLabel}
        taxBps={preview.taxBps}
        processingBps={preview.processingBps}
        exampleMinor={preview.exampleMinor}
        exampleBookingFeeMinor={preview.exampleBookingFeeMinor}
        termsBody={terms.body}
        termsSha256={terms.sha256}
        termsVersion={terms.version}
        termsDate="2 Nov 2026"
        accepted={current && acceptance ? { by: accepter?.name ?? "a member", on: fmtDay(acceptance.acceptedAt), version: acceptance.version } : null}
        mayAccept={binds}
        owners={owners}
        refundPolicy={refundPolicy}
        feesAbsorbed={feesAbsorbed}
      />
    )
  }

  return (
    <>
      <Panel title="Sell tickets for this event" hint="Owners and admins">
        <div className="flex flex-col gap-5">
          <PayoutStep
            eventId={eventId}
            orgName={org.display_name}
            status={payout?.status ?? "not_started"}
            linkedAccountId={payout?.linkedAccountId ?? null}
            submittedOn={submittedAt ? fmtDay(submittedAt).replace(/ \d{4}$/, "") : null}
            mayConnect={binds || isAdmin}
            isAdmin={isAdmin}
            owners={owners}
          />
          {turnOn ?? (
            <>
              <DimStep n={2} title="Fees and who pays them" hint="After your payout account is verified." />
              <DimStep n={3} title="Refund policy" />
              <DimStep n={4} title="Organizer Ticketing Terms" />
            </>
          )}
        </div>
      </Panel>
      <p className="text-[0.8125rem] text-muted-foreground">Until then the event stays free with “I’m going”. Nothing changes for people already going.</p>
    </>
  )
}
