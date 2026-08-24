import { db } from "./db"
import type { DateRange } from "./date-range"
import type { user_role } from "@prisma/client"
import { toCsv, type CsvColumn } from "./csv"
import { attendeeLabel } from "./pseudonym"
import { distinctAttendeeCounts } from "./attendee-counts"

/**
 * Report definitions.
 *
 * This exists because the login page has always advertised *"Exportable
 * reporting — download platform, organiser, and venue reports directly from the
 * dashboard"* and nothing in the product exported anything.
 *
 * Each report declares who may run it and what it selects. Scoping is part of
 * the definition rather than something the route remembers to apply — a report
 * added later cannot forget to filter by organiser and quietly hand one host
 * every other host's attendee list.
 *
 * No PII beyond what the running role already sees on screen. The attendee
 * report is the sharp one: an organiser sees who came to *their* events, which
 * they already see in the dashboard, and never an email address.
 */

export type ReportKey =
  | "events"
  | "attendees"
  | "check-ins"
  | "ratings"
  | "organisations"
  | "moderation"

export interface ReportDef {
  key: ReportKey
  label: string
  description: string
  roles: user_role[]
}

export const REPORTS: ReportDef[] = [
  {
    key: "events",
    label: "Events",
    description: "Every event in the window with capacity, RSVPs and attendance.",
    roles: ["app_admin", "organizer", "venue_owner"],
  },
  {
    key: "attendees",
    label: "Attendees",
    description: "Who attended, how often, and their no-show count. Pseudonymous.",
    roles: ["app_admin", "organizer"],
  },
  {
    key: "check-ins",
    label: "Check-ins",
    description: "Individual GPS-validated check-ins, one row each.",
    roles: ["app_admin", "organizer", "venue_owner"],
  },
  {
    key: "ratings",
    label: "Ratings",
    description: "Every rating left in the window, with the event it belongs to.",
    roles: ["app_admin", "organizer", "venue_owner"],
  },
  {
    key: "organisations",
    label: "Organisations",
    description: "Every host organisation, its members, events and verification state.",
    roles: ["app_admin"],
  },
  {
    key: "moderation",
    label: "Moderation",
    description: "Flags raised in the window and how each was resolved.",
    roles: ["app_admin"],
  },
]

export function reportsFor(role: user_role): ReportDef[] {
  return REPORTS.filter((r) => r.roles.includes(role))
}

export function canRunReport(key: string, role: user_role): boolean {
  return REPORTS.some((r) => r.key === key && r.roles.includes(role))
}

/**
 * Which events this actor may report on.
 *
 * `app_admin` gets everything. A host gets events their organisations run, plus
 * — for a venue owner — events at venues their organisations own, which mirrors
 * `eventPermissions.canOperate` exactly.
 */
/**
 * The salt for attendee pseudonyms.
 *
 * Stable for one organisation -- the attendees report counts events per person,
 * so a label that changed between exports would make "returning attendee"
 * meaningless -- and different across organisations, so two hosts cannot
 * compare exports and discover they had the same person.
 */
export async function pseudonymScope(role: user_role, userId: string): Promise<string> {
  if (role === "app_admin") return "platform"
  const memberships = await db.organisation_members.findMany({
    where: { user_id: userId },
    select: { org_id: true },
  })
  const orgIds = memberships.map((m) => m.org_id).sort()
  return orgIds.length > 0 ? orgIds.join(",") : `user:${userId}`
}

export async function eventScopeFor(role: user_role, userId: string) {
  if (role === "app_admin") return { deleted_at: null }

  const memberships = await db.organisation_members.findMany({
    where: { user_id: userId },
    select: { org_id: true },
  })
  const orgIds = memberships.map((m) => m.org_id)

  // No org means no events. Returning an unscoped filter here would export the
  // whole platform to someone with no organisation at all.
  if (orgIds.length === 0) return { deleted_at: null, id: { in: [] as string[] } }

  return {
    deleted_at: null,
    OR: [
      { organizer_org_id: { in: orgIds } },
      { organizer_id: userId },
      ...(role === "venue_owner" ? [{ venue: { owner_org_id: { in: orgIds } } }] : []),
    ],
  }
}

/**
 * The row ceiling every export shares.
 *
 * Three of the six had one and three did not -- `events`, `attendees` and
 * `organisations` were unbounded `findMany`s pulled into Node and folded in
 * memory. That is a request an admin can make from a browser that returns the
 * whole table, and the attendees one groups the whole thing into a Map first.
 *
 * A shared constant rather than three more literals, so a fourth export cannot
 * be written without a number to reach for -- which is how three of them came
 * to be missing it.
 */
export const REPORT_ROW_LIMIT = 10_000

/** A report's rows and its header, ready for `toCsv`. */
export async function buildReport(
  key: ReportKey,
  role: user_role,
  userId: string,
  range: DateRange
): Promise<string> {
  const scope = await eventScopeFor(role, userId)
  const labelScope = await pseudonymScope(role, userId)
  const inWindow = { gte: range.from, lt: range.to }

  switch (key) {
    case "events": {
      const rows = await db.events.findMany({
        where: { ...scope, start_time: inWindow },
        orderBy: { start_time: "desc" },
        take: REPORT_ROW_LIMIT,
        select: {
          id: true,
          title: true,
          status: true,
          start_time: true,
          end_time: true,
          city: true,
          venue_name: true,
          max_capacity: true,
          _count: {
            select: {
              rsvps: { where: { status: "going" } },
            },
          },
        },
      })
      /*
       * Attendance is a second query rather than a `_count`, because `_count`
       * has no DISTINCT and `event_check_ins` holds one row per person **per
       * day**. The Attended column read three times high on a three-day
       * conference, in the file that also promises the export is pseudonymous.
       */
      const attended = await distinctAttendeeCounts(rows.map((r) => r.id))
      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { key: "id", label: "Event ID" },
        { key: "title", label: "Title" },
        { key: "status", label: "Status" },
        { key: "start_time", label: "Starts" },
        { key: "end_time", label: "Ends" },
        { key: "city", label: "City" },
        { key: "venue_name", label: "Venue" },
        { key: "max_capacity", label: "Capacity" },
        { key: "going", label: "Going", value: (r) => r._count.rsvps },
        { key: "attended", label: "Attended", value: (r) => attended.get(r.id) ?? 0 },
        {
          key: "fill",
          label: "Fill %",
          // Blank rather than 0 when there is no declared capacity: an event
          // with no cap is not an event that failed to fill.
          value: (r) =>
            r.max_capacity ? Math.round((r._count.rsvps / r.max_capacity) * 100) : null,
        },
      ]
      return toCsv(columns, rows)
    }

    case "attendees": {
      const checkIns = await db.event_check_ins.findMany({
        where: {
          status: { in: ["checked_in", "checked_out"] },
          event: scope,
          created_at: inWindow,
        },
        select: { user_id: true, event_id: true, created_at: true },
        /*
         * Bounded, and ordered so the bound is meaningful.
         *
         * This was unbounded AND folded into a Map in memory, so the cost grew
         * with attendance-days rather than with people. Newest first, because a
         * truncated export of the most recent window is a usable answer and a
         * truncated export of an arbitrary slice is not.
         */
        orderBy: { created_at: "desc" },
        take: REPORT_ROW_LIMIT,
      })
      const byUser = new Map<string, { events: Set<string>; last: Date }>()
      for (const ci of checkIns) {
        const entry = byUser.get(ci.user_id) ?? { events: new Set<string>(), last: ci.created_at }
        entry.events.add(ci.event_id)
        if (ci.created_at > entry.last) entry.last = ci.created_at
        byUser.set(ci.user_id, entry)
      }
      const rows = [...byUser.entries()].map(([userId, v]) => ({
        // Pseudonymous by design: attendees are pseudonymous to hosts
        // everywhere in this product, and an export is not a way around that.
        attendee: attendeeLabel(userId, labelScope),
        events_attended: v.events.size,
        last_attended: v.last,
        repeat: v.events.size > 1,
      }))
      rows.sort((a, b) => b.events_attended - a.events_attended)
      return toCsv(
        [
          { key: "attendee", label: "Attendee" },
          { key: "events_attended", label: "Events attended" },
          { key: "last_attended", label: "Last attended" },
          { key: "repeat", label: "Repeat" },
        ],
        rows
      )
    }

    case "check-ins": {
      const rows = await db.event_check_ins.findMany({
        where: { event: scope, created_at: inWindow },
        orderBy: { created_at: "desc" },
        take: REPORT_ROW_LIMIT,
        select: {
          created_at: true,
          status: true,
          user_id: true,
          event: { select: { id: true, title: true, start_time: true } },
        },
      })
      return toCsv(
        [
          { key: "created_at", label: "Checked in at" },
          { key: "status", label: "Status" },
          { key: "attendee", label: "Attendee", value: (r) => attendeeLabel(r.user_id, labelScope) },
          { key: "event_id", label: "Event ID", value: (r) => r.event.id },
          { key: "event", label: "Event", value: (r) => r.event.title },
          { key: "event_start", label: "Event start", value: (r) => r.event.start_time },
        ],
        rows
      )
    }

    case "ratings": {
      const rows = await db.event_ratings.findMany({
        where: { event: scope, created_at: inWindow },
        orderBy: { created_at: "desc" },
        take: REPORT_ROW_LIMIT,
        select: {
          created_at: true,
          rating: true,
          event: { select: { id: true, title: true } },
        },
      })
      return toCsv(
        [
          { key: "created_at", label: "Rated at" },
          { key: "rating", label: "Rating" },
          { key: "event_id", label: "Event ID", value: (r) => r.event.id },
          { key: "event", label: "Event", value: (r) => r.event.title },
        ],
        rows
      )
    }

    case "organisations": {
      const rows = await db.organisations.findMany({
        orderBy: { created_at: "desc" },
        take: REPORT_ROW_LIMIT,
        include: {
          domains: { select: { domain: true, verified_at: true } },
          _count: { select: { members: true, events: true, venues: true } },
        },
      })
      return toCsv(
        [
          { key: "id", label: "Org ID" },
          { key: "display_name", label: "Name" },
          { key: "legal_name", label: "Legal name" },
          { key: "kind", label: "Kind" },
          { key: "status", label: "Status" },
          { key: "gstin", label: "GSTIN" },
          { key: "created_at", label: "Created" },
          { key: "members", label: "Members", value: (r) => r._count.members },
          { key: "events", label: "Events", value: (r) => r._count.events },
          { key: "venues", label: "Venues", value: (r) => r._count.venues },
          {
            key: "domains",
            label: "Verified domains",
            value: (r) =>
              r.domains
                .filter((d) => d.verified_at)
                .map((d) => d.domain)
                .join(" "),
          },
        ],
        rows
      )
    }

    case "moderation": {
      const rows = await db.moderation_flags.findMany({
        where: { created_at: inWindow },
        orderBy: { created_at: "desc" },
        take: REPORT_ROW_LIMIT,
        select: {
          created_at: true,
          status: true,
          source: true,
          categories: true,
          confidence: true,
          auto_action: true,
          reviewed_at: true,
        },
      })
      return toCsv(
        [
          { key: "created_at", label: "Raised" },
          { key: "status", label: "Status" },
          { key: "source", label: "Source" },
          {
            key: "categories",
            label: "Categories",
            // `categories` is a JSON column, so it is an array only by
            // convention. Anything else is stringified rather than throwing
            // mid-export and failing the whole download.
            value: (r) => (Array.isArray(r.categories) ? r.categories.join(" ") : r.categories),
          },
          { key: "confidence", label: "Confidence" },
          { key: "auto_action", label: "Auto action" },
          { key: "reviewed_at", label: "Reviewed" },
          {
            key: "hours_to_review",
            label: "Hours to review",
            value: (r) =>
              r.reviewed_at
                ? Math.round((r.reviewed_at.getTime() - r.created_at.getTime()) / 3_600_000)
                : null,
          },
        ],
        rows
      )
    }
  }
}
