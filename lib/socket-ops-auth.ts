import { decode } from "next-auth/jwt"
import type { user_role } from "@prisma/client"

// Relative, not "@/lib/db". `build:server` compiles this with plain tsc,
// which resolves the @/ alias for typechecking and then emits it verbatim into
// the require() — so the build goes green and the container dies on boot with
// MODULE_NOT_FOUND. Everything reachable from server.ts must use relative
// paths.
import { db } from "./db"
import { logger } from "./logger"
import { eventPermissions } from "./rbac"
import { actorFor } from "./org-membership"

/**
 * Dashboard authentication for Socket.io.
 *
 * The handshake previously accepted mobile JWTs only, so a NextAuth-session
 * dashboard client could not connect at all — which is why the "live" chat feed
 * is a 5-second poll.
 *
 * This is deliberately a separate module from the mobile path. The handshake is
 * load-bearing for every phone already in the field: the mobile verify runs
 * first and, if it succeeds, nothing here executes. Adding a second scheme to
 * an auth path is exactly where "additive" quietly stops being true, so the two
 * never share a code path.
 */

/**
 * NextAuth v4 names the cookie differently under https, and the socket
 * handshake gives us the raw header rather than a parsed jar.
 */
const SESSION_COOKIES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
]

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return decodeURIComponent(rest.join("="))
  }
  return undefined
}

export interface DashboardPrincipal {
  userId: string
  email: string
  role: user_role
}

/**
 * Resolve a dashboard session from the handshake, or null.
 *
 * Returning null rather than throwing matters: the caller has already failed
 * the mobile path, and a throw here would turn "not a dashboard user either"
 * into a 500-shaped failure instead of a clean auth rejection.
 */
export async function authenticateDashboardSocket(
  cookieHeader: string | undefined
): Promise<DashboardPrincipal | null> {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) return null

  const raw = SESSION_COOKIES.map((name) => readCookie(cookieHeader, name)).find(Boolean)
  if (!raw) return null

  try {
    const token = await decode({ token: raw, secret })
    if (!token?.sub) return null

    /*
     * Role is re-read from the database rather than trusted from the token.
     * A NextAuth JWT is signed, so it cannot be forged — but it can be stale:
     * a session issued before someone was demoted or suspended still carries
     * the old role until it expires. For a long-lived socket that outlives the
     * request that opened it, that window is the whole connection.
     */
    const user = await db.user.findUnique({
      where: { id: token.sub },
      select: { id: true, email: true, role: true, suspended_at: true, deletedAt: true },
    })
    if (!user) return null
    if (user.suspended_at) return null
    // An erased account's cookie can outlive it; deletion evicts the socket,
    // and this keeps the reconnect out (SCRUM-449).
    if (user.deletedAt) return null

    return { userId: user.id, email: user.email, role: user.role }
  } catch (error) {
    // A malformed or foreign cookie is an ordinary rejection, not an incident.
    logger.debug("Dashboard socket auth failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** Which copy of the live snapshot a watcher is sent. */
export type OpsView = "host" | "venue"

/** The room each view's snapshot is emitted to. Separate rooms, so one emit can never reach both. */
export const opsRoom = (eventId: string, view: OpsView) =>
  view === "host" ? `event:${eventId}:ops` : `event:${eventId}:ops:venue`

/**
 * May this dashboard user watch this event's live operations, and which copy?
 *
 * Same resolver the pages and API routes use, so the socket cannot drift into
 * a different answer from the screen that opened it. Operational access is the
 * bar: a venue owner gets the live view of an event in their building without
 * being able to edit it -- and, not running it, gets it as the venue: counts
 * as ranges (SCRUM-516). Whoever may edit it (its organisation, an admin)
 * gets the exact figures. Null when they may not watch at all.
 */
export async function eventOpsView(
  principal: DashboardPrincipal,
  eventId: string
): Promise<OpsView | null> {
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: { kind: true, organizer_org_id: true, start_time: true, venue: { select: { owner_org_id: true, claimed_at: true } } },
  })
  if (!event) return null

  // Memberships loaded through the shared helper so the socket cannot answer
  // the authorization question differently from the page that opened it.
  const { canOperate, canEdit } = eventPermissions(
    await actorFor({ id: principal.userId, role: principal.role }),
    event
  )
  if (!canOperate) return null
  return canEdit ? "host" : "venue"
}
