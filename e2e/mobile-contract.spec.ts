import { test, expect, request as playwrightRequest } from "@playwright/test"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"

import { signAccessToken } from "../lib/mobile-auth"

/**
 * E13 — the contract the mobile client will be migrated against.
 *
 * ## Verification, not a rewrite
 *
 * Measured across the tree: **all 64 mobile route files use
 * `lib/api-response`**, none uses a raw `NextResponse.json`. The envelope is
 * already uniform, so the client migration is a diff against a recorded shape
 * rather than a discovery exercise. This spec records that shape and fails when
 * it moves.
 *
 * ## Keys are recorded; values never are
 *
 * A snapshot holding a seeded person's name would break whenever the seed
 * changed, and would put real-looking personal data in the repository. Neither
 * is the contract. The contract is *which fields exist*.
 *
 * Re-record deliberately with `UPDATE_CONTRACTS=1 npm run test:e2e`. A snapshot
 * that rewrites itself every run asserts nothing.
 */

const CONTRACT_DIR = join(__dirname, "__contracts__")
const CONTRACT_FILE = join(CONTRACT_DIR, "mobile-api.json")
const UPDATE = process.env.UPDATE_CONTRACTS === "1"

/**
 * Read-only GETs, one per group.
 *
 * Deliberately not every route: a POST that mutates the seeded world makes the
 * suite order-dependent, and it returns the same envelope anyway. What this
 * covers is the *read* surface a client renders.
 */
const ROUTES = [
  "/api/mobile/events",
  "/api/mobile/events/cities",
  "/api/mobile/events/search?q=sessions",
  "/api/mobile/categories",
  "/api/mobile/amenities",
  "/api/mobile/work-fields",
  "/api/mobile/venues",
  "/api/mobile/conversations",
  "/api/mobile/chat/groups",
  "/api/mobile/notifications",
  "/api/mobile/message-requests",
  "/api/mobile/users/blocked",
  /*
   * The board's two reads. Both are new client surfaces with no caller yet, so
   * this is the shape the Phase 2 migration will be written against — recorded
   * now, while it is fresh, rather than reconstructed from `git log` in six
   * weeks.
   */
  "/api/mobile/board/requests",
]

/**
 * Routes with no GET at all, and what they answer instead.
 *
 * `/api/mobile/account` exports only `DELETE` — account erasure. A GET is a 405
 * with an empty body, which is correct and is *also* the one shape that cannot
 * carry the envelope. Listing it here says so, rather than either failing the
 * envelope check or quietly dropping the route from coverage.
 */
const NO_GET: Record<string, number> = {
  "/api/mobile/account": 405,
}

/**
 * Reads that need an id, recorded under their template so the snapshot holds
 * no seeded uuid.
 *
 * `pin` records the keys of objects one level down as well, because the drift
 * these were added for (SCRUM-460) lived there — `chatGroup.member_count`, the
 * snake_case group history, the owner's profile row — where the top-level
 * shape cannot see it. `messages[]` is the first message.
 *
 * Two of them write: the event read counts a view, and the event chat read
 * moves the caller's read marker. Neither is a shape any spec records.
 */
type ParamRoute = { url: string; pin?: string[] }

type Shape = {
  status: number
  envelope: string[]
  data: string[] | string
  nested?: Record<string, string[] | string>
}

const describe = (v: unknown): string[] | string => {
  if (Array.isArray(v)) return v.length ? [`array<${String(describe(v[0]))}>`] : ["array<empty>"]
  if (v && typeof v === "object") return Object.keys(v as object).sort()
  return typeof v
}

/** `a.b[]` — `[]` takes the first element. */
const at = (v: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, segment) => {
    const list = segment.endsWith("[]")
    const value = (node as Record<string, unknown> | null)?.[list ? segment.slice(0, -2) : segment]
    return list ? (value as unknown[] | undefined)?.[0] : value
  }, v)

/** Keys, not values — see the docblock. */
function shapeOf(status: number, body: unknown, pin: string[] = []): Shape {
  const top = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  return {
    status,
    envelope: Object.keys(top).sort(),
    data: describe(top.data ?? null),
    ...(pin.length > 0 && { nested: Object.fromEntries(pin.map((p) => [p, describe(at(top.data, p))])) }),
  }
}

test.describe("mobile API contract", () => {
  test("every read route answers in the shared envelope, with a stable shape", async ({
    baseURL,
  }) => {
    const db = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        /*
         * One connection, because a spec file queries sequentially.
         *
         * Tidiness, not a fix, and the distinction is worth keeping. I capped these
         * believing five spec pools of ten, plus the server's twenty, were exhausting
         * Postgres' hundred and hanging CI. Measured: peak connections were **21 with
         * the caps and 21 without** — node-postgres pools lazily and these specs never
         * open more than one. The hypothesis was arithmetic, not evidence.
         *
         * The real cause was the organisation being over its Actions minutes; `e2e` is
         * the longest job and so the only one reclaimed. The cap stays because ten
         * connections for a sequential file is still wrong, not because it changed
         * anything.
         */
        max: 1,
      }),
    })
    const user = await db.user.findUnique({
      where: { email: "ananya.b@blendn.app" },
      select: { id: true, email: true },
    })
    // The QA seed's live event, whose room it fills with one line per attendee.
    const live = await db.events.findUnique({
      where: { slug: "founders-filter-coffee" },
      select: { id: true, venue_id: true, chat_group: { select: { id: true } } },
    })
    await db.$disconnect()
    expect(user, "the QA seed must have run — this is a seeded attendee").toBeTruthy()
    expect(live?.chat_group, "the QA seed's live event must have its room").toBeTruthy()
    expect(live?.venue_id, "the QA seed's live event must be at a venue").toBeTruthy()

    const eventId = live!.id
    const PARAM_ROUTES: Record<string, ParamRoute> = {
      "/api/mobile/events/:eventId": { url: `/api/mobile/events/${eventId}`, pin: ["chatGroup"] },
      "/api/mobile/events/:eventId/interested-users": { url: `/api/mobile/events/${eventId}/interested-users` },
      "/api/mobile/events/:eventId/chat": {
        url: `/api/mobile/events/${eventId}/chat`,
        pin: ["write", "mute", "messages[]"],
      },
      "/api/mobile/chat/groups/:chatGroupId/messages": {
        url: `/api/mobile/chat/groups/${live!.chat_group!.id}/messages`,
        pin: ["messages[]", "pagination"],
      },
      "/api/mobile/profiles/:userId (own)": { url: `/api/mobile/profiles/${user!.id}`, pin: ["profile"] },
      // A Go Live is an active check-in too: `kind`, `expiresAt` and `stay` say which (step 4).
      "/api/mobile/checkins/active": { url: "/api/mobile/checkins/active", pin: ["checkIns[]"] },
      // Go Live's venue (PL-C02): `venue` must never grow a `geofence`.
      "/api/mobile/venues/:venueId": { url: `/api/mobile/venues/${live!.venue_id}`, pin: ["venue", "live"] },
    }

    const token = signAccessToken(user!.id, user!.email)
    const ctx = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })

    const recorded: Record<string, Shape> = {}
    const notEnveloped: string[] = []
    const reads: [string, ParamRoute][] = [
      ...ROUTES.map((url): [string, ParamRoute] => [url, { url }]),
      ...Object.entries(PARAM_ROUTES),
    ]

    for (const [route, { url, pin }] of reads) {
      const res = await ctx.get(url)
      const body = await res.json().catch(() => null)
      recorded[route] = shapeOf(res.status(), body, pin)

      /*
       * The envelope is the migration's whole premise. `lib/api-response.ts`
       * answers `success` plus `data` or `error`; a route that answers
       * differently is one the client must special-case, which is exactly what
       * this epic exists to prevent.
       */
      const keys = recorded[route].envelope
      if (!keys.includes("success")) notEnveloped.push(`${route} -> {${keys.join(", ")}}`)
    }
    for (const [route, status] of Object.entries(NO_GET)) {
      const res = await ctx.get(route)
      expect(res.status(), `${route} has no GET and must say so`).toBe(status)
    }
    await ctx.dispose()

    expect(
      notEnveloped,
      "every mobile route must answer through lib/api-response — one that does not is a route " +
        "the client has to special-case"
    ).toEqual([])

    mkdirSync(CONTRACT_DIR, { recursive: true })
    if (UPDATE || !existsSync(CONTRACT_FILE)) {
      writeFileSync(CONTRACT_FILE, JSON.stringify(recorded, null, 2) + "\n")
      test.info().annotations.push({ type: "contract", description: "recorded" })
      return
    }

    const previous = JSON.parse(readFileSync(CONTRACT_FILE, "utf8")) as Record<string, Shape>
    expect(
      recorded,
      "A mobile response shape changed. If that was deliberate, re-record with " +
        "UPDATE_CONTRACTS=1 — the diff is then the note the client team migrates against."
    ).toEqual(previous)
  })

  test("an unauthenticated caller is refused, in the same envelope", async ({ request }) => {
    /*
     * The negative half. Without it the recording above would look identical
     * against an API that had stopped checking tokens altogether.
     */
    const res = await request.get("/api/mobile/conversations")
    expect(res.status()).toBe(401)
    const body = await res.json()
    expect(body).toMatchObject({ success: false })
    expect(body.errorCode, "a machine-readable code, not only prose").toBeTruthy()
  })
})
