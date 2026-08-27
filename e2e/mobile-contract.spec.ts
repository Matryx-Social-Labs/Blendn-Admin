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
  "/api/mobile/checkins/active",
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

type Shape = { status: number; envelope: string[]; data: string[] | string }

/** Keys, not values — see the docblock. */
function shapeOf(status: number, body: unknown): Shape {
  const describe = (v: unknown): string[] | string => {
    if (Array.isArray(v)) return v.length ? [`array<${String(describe(v[0]))}>`] : ["array<empty>"]
    if (v && typeof v === "object") return Object.keys(v as object).sort()
    return typeof v
  }
  const top = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  return {
    status,
    envelope: Object.keys(top).sort(),
    data: describe(top.data ?? null),
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
         * Left unset, `@prisma/adapter-pg` takes node-postgres' default of ten.
         * Five spec files each opened a pool that size, alongside the server's
         * twenty, against Postgres' default `max_connections` of 100 — and pools
         * are not released between files. In CI that showed as `mobile-contract`
         * taking 28.8s against 0.5s locally, and then the next spec hanging for
         * the full 45s test timeout waiting for a connection that never freed.
         * The job was reported as cancelled, which is what sent me looking at
         * runner memory and disk for three runs.
         */
        max: 1,
      }),
    })
    const user = await db.user.findUnique({
      where: { email: "ananya.b@blendn.app" },
      select: { id: true, email: true },
    })
    await db.$disconnect()
    expect(user, "the QA seed must have run — this is a seeded attendee").toBeTruthy()

    const token = signAccessToken(user!.id, user!.email)
    const ctx = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })

    const recorded: Record<string, Shape> = {}
    const notEnveloped: string[] = []

    for (const route of ROUTES) {
      const res = await ctx.get(route)
      const body = await res.json().catch(() => null)
      recorded[route] = shapeOf(res.status(), body)

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
