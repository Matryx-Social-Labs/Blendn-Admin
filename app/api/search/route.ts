import { NextRequest, NextResponse } from "next/server"
import { errorResponse } from "@/lib/api-response"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { rateLimit, userLimit } from "@/lib/rate-limit"

/**
 * Global search, behind ⌘K.
 *
 * Scoped by role in the query itself, not filtered after the fact: a host
 * searching "priya" must not get a result count that tells them how many users
 * named Priya exist on the platform, and an empty result list is the only
 * honest answer for data they cannot see.
 *
 * `contains` with `mode: "insensitive"` rather than full-text search. At this
 * data volume a trigram index would be a migration and an operational concern
 * to serve queries that return in single-digit milliseconds against a few
 * thousand rows. It is a seam: when the row counts justify it, this is the one
 * file that changes.
 */

const LIMIT = 5

export interface SearchHit {
  id: string
  type: "event" | "user" | "organisation" | "venue"
  title: string
  subtitle: string | null
  href: string
}

export async function GET(req: NextRequest) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const limited = await rateLimit(req, userLimit("write", "search", session.user.id))
    if (limited) return limited

    const q = new URL(req.url).searchParams.get("q")?.trim() ?? ""
    // Two characters is where the results stop being "everything".
    if (q.length < 2) return NextResponse.json({ hits: [] })

    const role = session.user.role
    const isAdmin = role === "app_admin"
    const contains = { contains: q, mode: "insensitive" as const }

    // Which events this person may reach, mirroring eventPermissions.
    const orgIds = isAdmin
      ? []
      : (
          await db.organisation_members.findMany({
            where: { user_id: session.user.id },
            select: { org_id: true },
          })
        ).map((m) => m.org_id)

    const eventScope = isAdmin
      ? { deleted_at: null }
      : {
          deleted_at: null,
          OR: [
            { organizer_org_id: { in: orgIds } },
            { organizer_id: session.user.id },
            ...(role === "venue_owner" ? [{ venue: { owner_org_id: { in: orgIds } } }] : []),
          ],
        }

    const [events, users, orgs, venues] = await Promise.all([
      db.events.findMany({
        where: { ...eventScope, OR: [{ title: contains }, { venue_name: contains }, { city: contains }] },
        orderBy: { start_time: "desc" },
        take: LIMIT,
        select: { id: true, title: true, start_time: true, city: true, status: true },
      }),
      // Platform-wide user search is admin-only. A host searching people would
      // be a directory of every attendee on Blend'n.
      isAdmin
        ? db.user.findMany({
            where: { deletedAt: null, OR: [{ name: contains }, { email: contains }] },
            take: LIMIT,
            select: { id: true, name: true, email: true, role: true },
          })
        : Promise.resolve([]),
      isAdmin
        ? db.organisations.findMany({
            where: { OR: [{ display_name: contains }, { legal_name: contains }] },
            take: LIMIT,
            select: { id: true, display_name: true, status: true, kind: true },
          })
        : Promise.resolve([]),
      db.venues.findMany({
        where: {
          OR: [{ name: contains }, { city: contains }],
          ...(isAdmin ? {} : { owner_org_id: { in: orgIds } }),
        },
        take: LIMIT,
        select: { id: true, name: true, city: true },
      }),
    ])

    const hits: SearchHit[] = [
      ...events.map((e) => ({
        id: e.id,
        type: "event" as const,
        title: e.title,
        subtitle: [
          e.city,
          new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(e.start_time),
          e.status,
        ]
          .filter(Boolean)
          .join(" · "),
        href: `/dashboard/events/${e.id}`,
      })),
      ...orgs.map((o) => ({
        id: o.id,
        type: "organisation" as const,
        title: o.display_name,
        subtitle: `${o.kind} · ${o.status}`,
        href: `/dashboard/organisations`,
      })),
      ...users.map((u) => ({
        id: u.id,
        type: "user" as const,
        title: u.name ?? u.email,
        subtitle: `${u.email} · ${u.role}`,
        href: `/dashboard/users`,
      })),
      ...venues.map((v) => ({
        id: v.id,
        type: "venue" as const,
        title: v.name,
        subtitle: v.city,
        href: `/dashboard/venue-owners`,
      })),
    ]

    return NextResponse.json({ hits })
  } catch (err) {
    logger.error("Search failed", { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ hits: [] })
  }
}
