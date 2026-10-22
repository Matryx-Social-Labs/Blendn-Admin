import { db } from "./db"
import { realEventsWhere } from "./event-kind"
import { decodeKeyset, encodeKeyset, type Keyset } from "./pagination"
import { mayAttendWhere, undisputedLinkWhere } from "./venue-visibility"

/** How many of the venue's coming events the page lists, and the default page of the full list. */
export const UPCOMING_LIMIT = 5

/**
 * A venue's coming events as a person may see them: the Places card's filter
 * (`GET /venues`), so the page, the card and the full list agree on what is
 * coming. Never the venue's own live rooms (F3): they are not events at it.
 */
function upcomingWhere(venueId: string, now: Date, viewerAge: number | null | undefined) {
  return {
    venue_id: venueId,
    deleted_at: null,
    ...realEventsWhere,
    status: "published" as const,
    visibility: "public" as const,
    end_time: { gte: now },
    AND: [undisputedLinkWhere, ...(typeof viewerAge === "number" ? [mayAttendWhere(viewerAge)] : [])],
  }
}

/** Soonest first, `id` to make the order total: rows sharing a start are never repeated or lost at a page edge. */
const SOONEST = [{ start_time: "asc" as const }, { id: "asc" as const }]

/** The rows after a cursor in `SOONEST` order. */
const afterStart = (k: Keyset) => {
  const at = k.at ?? new Date(0)
  return { OR: [{ start_time: { gt: at } }, { start_time: at, id: { gt: k.id } }] }
}

const eventSelect = { id: true, title: true, slug: true, cover_image_url: true, start_time: true, end_time: true } as const

export interface UpcomingPage {
  events: { id: string; title: string; slug: string; coverImageUrl: string | null; startTime: Date; endTime: Date }[]
  /** All of them, whatever page this is. */
  total: number
  /** Resume here; null on the last page. */
  nextCursor: string | null
}

/**
 * One page of a venue's coming events, and how many there are in all. A cursor
 * that is not ours is `"bad_cursor"`.
 */
export async function venueUpcoming(
  venueId: string,
  now: Date,
  viewerAge: number | null | undefined,
  opts: { limit?: number; cursor?: string | null } = {}
): Promise<UpcomingPage | "bad_cursor"> {
  const limit = opts.limit ?? UPCOMING_LIMIT
  const after = opts.cursor ? decodeKeyset(opts.cursor) : null
  if (opts.cursor && !after) return "bad_cursor"

  const base = upcomingWhere(venueId, now, viewerAge)
  const [total, rows] = await Promise.all([
    db.events.count({ where: base }),
    db.events.findMany({
      where: after ? { AND: [base, afterStart(after)] } : base,
      orderBy: SOONEST,
      take: limit + 1,
      select: eventSelect,
    }),
  ])
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    events: page.map((e) => ({
      id: e.id,
      title: e.title,
      slug: e.slug,
      coverImageUrl: e.cover_image_url,
      startTime: e.start_time,
      endTime: e.end_time,
    })),
    total,
    nextCursor: hasMore && last ? encodeKeyset(last.start_time, last.id) : null,
  }
}
