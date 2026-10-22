import { PAGINATION } from "@/lib/constants"

export interface PaginationParams {
  page: number
  limit: number
}

export interface PaginationMeta {
  page: number
  limit: number
  totalCount: number
  totalPages: number
  hasMore: boolean
}

export interface CursorPaginationParams {
  cursor?: string
  limit: number
}

export interface CursorPaginationMeta {
  limit: number
  hasMore: boolean
  nextCursor?: string
}

/**
 * Parse and validate offset-based pagination params.
 * Use for stable, countable lists (events, users, favorites).
 */
export function parsePagination(
  page?: number | string,
  limit?: number | string
): PaginationParams {
  return {
    page: boundedInt(page == null ? null : String(page), PAGINATION.DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER),
    limit: boundedInt(limit == null ? null : String(limit), PAGINATION.DEFAULT_LIMIT, 1, PAGINATION.MAX_LIMIT),
  }
}

/**
 * A whole number from a query string: `fallback` when it isn't one, then held
 * to [min, max]. `parseInt("abc")` is NaN, and a NaN `take` is a Prisma error
 * the route's catch-all reported as a 500 (SCRUM-430).
 */
export function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Math.min(max, Math.max(min, Number.isNaN(n) ? fallback : n))
}

/**
 * Compute pagination metadata from total count.
 */
export function paginationMeta(
  page: number,
  limit: number,
  totalCount: number
): PaginationMeta {
  return {
    page,
    limit,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    hasMore: page * limit < totalCount,
  }
}

/**
 * Compute skip value for Prisma queries.
 */
export function paginationSkip(page: number, limit: number): number {
  return (page - 1) * limit
}

/**
 * Parse cursor-based pagination params.
 * Use for real-time, append-heavy lists (chat messages).
 */
export function parseCursorPagination(
  cursor?: string,
  limit?: number | string
): CursorPaginationParams {
  const l = boundedInt(limit == null ? null : String(limit), PAGINATION.DEFAULT_CHAT_LIMIT, 1, PAGINATION.MAX_LIMIT)
  return { cursor: cursor || undefined, limit: l }
}

/**
 * Build cursor pagination meta.
 * Pass items fetched with limit+1 to detect hasMore.
 */
export function cursorPaginationMeta<T extends { id: string }>(
  items: T[],
  limit: number
): { items: T[]; meta: CursorPaginationMeta } {
  const hasMore = items.length > limit
  const trimmed = hasMore ? items.slice(0, limit) : items
  return {
    items: trimmed,
    meta: {
      limit,
      hasMore,
      nextCursor: hasMore ? trimmed[trimmed.length - 1]?.id : undefined,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Keyset cursors for lists that grow without bound                            */
/* -------------------------------------------------------------------------- */

/**
 * Page sizes for the lists a person accumulates (SCRUM-760). A first page
 * is sized so an installed client, which has no way to ask for a second one,
 * still shows what a person has in practice: nobody has fifty live
 * conversations, and the Friends list a phone draws is its first hundred.
 */
export const LIST_PAGE = {
  /** `GET /conversations`: the inbox. */
  CONVERSATIONS: 50,
  /** `GET /friends`, `GET /users/blocked`, `GET /events/:id/board`. */
  PEOPLE: 100,
  /** Each of `GET /friends/requests`' two lists. */
  REQUESTS: 50,
  /** No page is ever larger than this, whatever `limit` asks for. */
  MAX: 100,
} as const

/**
 * Where a page ended: the last row's time (null for a row with none) and id.
 * `createdAt` is the second time, for a list sorted on a nullable column whose
 * empty rows are then ordered by when they were made (the inbox).
 */
export interface Keyset {
  at: Date | null
  id: string
  createdAt?: Date
}

/** Opaque to the client: base64url of `{ t, id }` (and `c`). */
export function encodeKeyset(at: Date | null, id: string, createdAt?: Date): string {
  return Buffer.from(
    JSON.stringify({ t: at ? at.toISOString() : null, id, ...(createdAt && { c: createdAt.toISOString() }) })
  ).toString("base64url")
}

/**
 * The cursor back, or `null` when it is not one of ours — the route answers 400
 * rather than guessing, so a tampered cursor is never an unbounded read.
 */
export function decodeKeyset(raw: string): Keyset | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; id?: unknown; c?: unknown }
    if (typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 64) return null
    const date = (v: unknown): Date | null | undefined =>
      v === null ? null : typeof v === "string" && !Number.isNaN(new Date(v).getTime()) ? new Date(v) : undefined
    const at = date(parsed.t)
    const createdAt = parsed.c === undefined ? undefined : date(parsed.c)
    if (at === undefined || createdAt === null || (parsed.c !== undefined && createdAt === undefined)) return null
    return { at, id: parsed.id, ...(createdAt && { createdAt }) }
  } catch {
    return null
  }
}

/**
 * The rows after `k` in `created_at DESC, id DESC` order: older, or the same
 * instant and a smaller id. Without the id half, two rows sharing a timestamp
 * (a bulk insert, a seeded world) are skipped or repeated at a page edge.
 */
export function createdBefore(k: Keyset): {
  OR: [{ created_at: { lt: Date } }, { created_at: Date; id: { lt: string } }]
} {
  const at = k.at ?? new Date(0)
  return { OR: [{ created_at: { lt: at } }, { created_at: at, id: { lt: k.id } }] }
}

/** `created_at DESC, id DESC`, the order `createdBefore` continues. */
export const NEWEST_FIRST = [{ created_at: "desc" as const }, { id: "desc" as const }]

/**
 * A page of `limit` from `limit + 1` rows read, and the cursor for the next.
 * `cursorOf` names the row's keyset.
 */
export function keysetPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => Keyset
): { items: T[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  const k = hasMore && last ? cursorOf(last) : null
  return { items, hasMore, nextCursor: k ? encodeKeyset(k.at, k.id, k.createdAt) : null }
}

/**
 * What an installed build, which cannot page and sends neither `limit` nor
 * `cursor`, is answered with: up to this many. It is the old behaviour in
 * practice (nobody has more) without the unbounded read, and it sits above
 * `LIST_PAGE.MAX` on purpose, so it is decided BEFORE the 1-100 clamp.
 */
export const LEGACY_PAGE = 200

/**
 * `?limit=&cursor=` for a list. A request with neither is a build that cannot
 * page: it gets `legacyLimit` when the route has one (see `LEGACY_PAGE`).
 * Anything that names a `limit` or a `cursor` is a client that pages, and gets
 * `defaultLimit` unless it says otherwise, 1-100 (`LIST_PAGE.MAX`). The legacy
 * case comes first, before the clamp, or 200 would be turned into 100.
 * `"bad_cursor"` for a cursor that is not one of ours (the route answers 400);
 * `after` is null on the first page.
 */
export function parseListQuery(
  searchParams: URLSearchParams,
  defaultLimit: number,
  legacyLimit?: number
): { limit: number; after: Keyset | null } | "bad_cursor" {
  const raw = searchParams.get("cursor")
  const asked = searchParams.get("limit")
  const limit =
    legacyLimit !== undefined && !raw && asked === null
      ? legacyLimit
      : boundedInt(asked, defaultLimit, 1, LIST_PAGE.MAX)
  if (!raw) return { limit, after: null }
  const after = decodeKeyset(raw)
  return after ? { limit, after } : "bad_cursor"
}

/** The `pagination` block every cursor-paged list answers with. */
export interface ListPagination {
  limit: number
  hasMore: boolean
  nextCursor: string | null
  /** The whole list, whatever page this is: the count a header says. */
  totalCount: number
}

/* -------------------------------------------------------------------------- */
/* Page numbers AND a keyset cursor, for the lists installed builds page by    */
/* -------------------------------------------------------------------------- */

/** How a list is being read: the old way (`page`) or by keyset (`cursor`). */
export type PagedQuery =
  | { mode: "page"; page: number; limit: number }
  | { mode: "cursor"; limit: number; after: { at: Date; id: string } }

/**
 * `?page=&limit=` as it always was, plus `?cursor=` (the last page's
 * `pagination.nextCursor`). A `cursor` wins and pages by keyset; otherwise
 * `page` and `limit` mean what they meant, and a request with none of the three
 * is a build that cannot page and gets `LEGACY_PAGE`, as in `parseListQuery`.
 * `"bad_cursor"` for a cursor that is not one of ours or does not name a uuid
 * row (the routes answer 400): these lists key on uuids, and Postgres would
 * make anything else a 500.
 */
export function parsePageOrCursor(
  searchParams: URLSearchParams,
  uuid: (value: string) => boolean,
  defaultLimit: number = PAGINATION.DEFAULT_LIMIT
): PagedQuery | "bad_cursor" {
  const raw = searchParams.get("cursor")
  const asked = searchParams.get("limit")
  const page = searchParams.get("page")
  if (raw) {
    const after = decodeKeyset(raw)
    if (!after || !after.at || !uuid(after.id)) return "bad_cursor"
    return { mode: "cursor", limit: boundedInt(asked, defaultLimit, 1, LIST_PAGE.MAX), after: { at: after.at, id: after.id } }
  }
  const limit = asked === null && page === null ? LEGACY_PAGE : boundedInt(asked, defaultLimit, 1, LIST_PAGE.MAX)
  return { mode: "page", page: boundedInt(page, PAGINATION.DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER), limit }
}

/**
 * The `pagination` block for a `parsePageOrCursor` list: the old page block
 * plus `nextCursor` on the page route, and the cursor lists' block
 * (`ListPagination`) on a cursor one. `totalCount` is the whole list either way.
 */
export function pagedPagination(
  query: PagedQuery,
  totalCount: number,
  page: { hasMore: boolean; nextCursor: string | null }
) {
  return query.mode === "page"
    ? { ...paginationMeta(query.page, query.limit, totalCount), nextCursor: page.nextCursor }
    : { limit: query.limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount }
}
