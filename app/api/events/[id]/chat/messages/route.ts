import { logger } from "@/lib/logger"
import { errorResponse } from "@/lib/api-response"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { isUuid } from "@/lib/api-input"
import { liveCountBucket, liveCountLabel } from "@/lib/disclosure"
import { idForViewer } from "@/lib/room-handle"

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * What the organiser's feed badges a message as. The room's own voice — an
 * announcement, a poll, a sponsored send — is badged rather than named. A poll
 * fell through to "user" and read "Attendee" here while the phones named it
 * after the organisation (SCRUM-307). A sponsored poll is sponsored.
 */
function feedKind(m: { type: string; metadata: unknown }): "user" | "announcement" | "poll" | "sponsored" {
  const meta = m.metadata as { sponsored_message_id?: string; kind?: string } | null
  if (meta?.sponsored_message_id) return "sponsored"
  if (m.type === "poll") return meta?.kind === "sponsored" ? "sponsored" : "poll"
  if (m.type === "announcement") return "announcement"
  return "user"
}

const MEMBER_SELECT = {
  user_id: true,
  anonymous_name: true,
  role: true,
  status: true,
  banned_at: true,
  banned_by: true,
  muted_at: true,
} as const

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { kind: true, organizer_org_id: true, start_time: true, venue: { select: { owner_org_id: true, claimed_at: true } }, chat_group: { select: { id: true } } },
    })
    if (!event) return errorResponse("Not found", 404)
    const permissions = eventPermissions(await actorFor(session.user), event)
    if (!permissions.canOperate) {
      return errorResponse("Forbidden", 403)
    }
    // The full shape even when there is no room yet — the feed types
    // `pendingFlags` and `members` as required.
    if (!event.chat_group) {
      return NextResponse.json({ chatGroupId: null, pendingFlags: 0, activeCount: 0, messages: [], members: [] })
    }

    /*
     * Attendees are pseudonymous in event chat: they get an `anonymous_name` on
     * check-in and every mobile surface shows that instead of who they are. The
     * point is honest feedback — an attendee who knows the organiser can see
     * their name does not say the venue was filthy.
     *
     * The dashboard UI already rendered only the pseudonym, but this route was
     * shipping `name` and `email` in the JSON regardless, so any host could read
     * the real identity of every "anonymous" attendee out of the network tab.
     * The anonymity was cosmetic.
     *
     * Real identity is now admin-only. Hosts get nothing that names a person —
     * and not the account id either (SCRUM-517). It is the same in every room,
     * so a host across several nights joined them into one person's history;
     * they get this room's handle instead (SCRUM-371), which bans and mutes
     * through /chat/members/[userId] and means nothing in the next room.
     */
    // Shaping pinned by __tests__/chat-identity.test.ts — keep them in step.
    const isPlatformAdmin = session.user.role === "app_admin"
    const idFor = (userId: string) =>
      isPlatformAdmin ? userId : idForViewer(session.user.id, eventId, userId)

    /*
     * The poll asks for `?light=1` while the Messages tab is open: it is polled
     * every 5 seconds per open room, and the whole roster (5,000 rows in a big
     * room) is only what the Members tab shows. A light read carries the members
     * that change what a message looks like -- whoever is restricted, and the
     * authors of the messages returned -- and `activeCount` for the header; the
     * client keeps the rest of the roster from its last full read.
     */
    const light = new URL(request.url).searchParams.get("light") === "1"

    // One wave. These depend only on the chat group id; they ran one
    // after another, and this route is polled every 5 seconds per open room.
    const chatGroupId = event.chat_group.id
    const [messages, roster, violationCounts, pendingFlags, activeCount] = await Promise.all([
      db.chat_messages.findMany({
        where: { chat_group_id: chatGroupId, deleted_at: null },
        orderBy: { created_at: "desc" },
        take: 100,
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
      // Members with banned_by user info
      db.chat_group_members.findMany({
        where: { chat_group_id: chatGroupId, ...(light && { status: { in: ["banned", "muted"] } }) },
        select: MEMBER_SELECT,
      }),
      // Violation counts per user (hidden messages)
      db.moderation_flags.groupBy({
        by: ["user_id"],
        where: { chat_group_id: chatGroupId, auto_action: "hidden" },
        _count: { id: true },
      }),
      // What is waiting on a human — the one live number the organiser's
      // screen has for the moderation queue.
      db.moderation_flags.count({
        where: { chat_group_id: chatGroupId, status: "pending" },
      }),
      db.chat_group_members.count({ where: { chat_group_id: chatGroupId, status: "active" } }),
    ])
    // The authors a light read has not got yet (the restricted came in the roster).
    const known = new Set(roster.map((m) => m.user_id))
    const missingAuthors = light ? [...new Set(messages.map((m) => m.user_id))].filter((id) => !known.has(id)) : []
    const members =
      missingAuthors.length > 0
        ? [
            ...roster,
            ...(await db.chat_group_members.findMany({
              where: { chat_group_id: chatGroupId, user_id: { in: missingAuthors } },
              select: MEMBER_SELECT,
            })),
          ]
        : roster
    const memberMap = new Map(members.map((m) => [m.user_id, m]))
    const violationMap = new Map(violationCounts.map((v) => [v.user_id, v._count.id]))

    // Fetch recent violations for banned/muted users
    const restrictedUserIds = members
      .filter((m) => m.status === "banned" || m.status === "muted")
      .map((m) => m.user_id)

    // Second wave: the two lookups that need `members`, together.
    const bannedByIds = [...new Set(members.filter((m) => m.banned_by).map((m) => m.banned_by!))]
    const [recentViolations, bannedByUsers] = await Promise.all([
      restrictedUserIds.length > 0
        ? db.moderation_flags.findMany({
            where: { chat_group_id: chatGroupId, user_id: { in: restrictedUserIds } },
            orderBy: { created_at: "desc" },
            take: 100,
            select: {
              user_id: true,
              source: true,
              categories: true,
              confidence: true,
              auto_action: true,
              created_at: true,
              message: { select: { content: true } },
            },
          })
        : [],
      bannedByIds.length > 0
        ? db.user.findMany({ where: { id: { in: bannedByIds } }, select: { id: true, name: true } })
        : [],
    ])

    // Group violations by user
    const violationsByUser = new Map<string, typeof recentViolations>()
    for (const v of recentViolations) {
      const existing = violationsByUser.get(v.user_id) ?? []
      existing.push(v)
      violationsByUser.set(v.user_id, existing)
    }

    const bannedByMap = new Map(bannedByUsers.map((u) => [u.id, u.name]))

    return NextResponse.json({
      chatGroupId: event.chat_group.id,
      pendingFlags,
      // A venue reads rooms as ranges (SCRUM-516, SCRUM-891). Its Members tab still lists whom it moderates.
      activeCount: permissions.canEdit ? activeCount : liveCountLabel(liveCountBucket(activeCount)),
      messages: messages.reverse().map((m) => ({
        id: m.id,
        content: m.content,
        type: m.type,
        /*
         * What the row is, since `type` cannot say: a sponsored send keeps
         * `type` for its media kind and marks itself in metadata (see
         * lib/sponsored-scheduler.ts). Without this the organiser's own feed
         * showed their announcement and the sponsor's ad as messages from
         * "Attendee" (K3.10) — the same string an attendee could type.
         */
        kind: feedKind(m),
        createdAt: m.created_at.toISOString(),
        user: {
          id: idFor(m.user.id),
          anonymousName: memberMap.get(m.user.id)?.anonymous_name ?? null,
          // Admin-only. Absent, not null, for hosts — so a client that reads
          // `user.name` gets undefined rather than a convincing blank.
          ...(isPlatformAdmin
            ? { name: m.user.name, email: m.user.email, image: m.user.image }
            : {}),
        },
      })),
      // By pseudonym, never in the order the rows were written: that is the door's (SCRUM-887).
      members: [...members].sort((a, b) => (a.anonymous_name ?? "\uffff").localeCompare(b.anonymous_name ?? "\uffff")).map((m) => ({
        userId: idFor(m.user_id),
        anonymousName: m.anonymous_name,
        // `admin` is the host (or a colleague) holding the room: not moderated here (SCRUM-466).
        role: m.role,
        status: m.status,
        bannedAt: m.banned_at?.toISOString() ?? null,
        bannedByName: m.banned_by ? bannedByMap.get(m.banned_by) ?? null : null,
        // `muted_at`, not `updated_at`: that column has `@default(now())` and no
        // `@updatedAt`, so it is the join time, and the Members tab read
        // "Muted <when they joined>" (SCRUM-154).
        mutedAt: m.muted_at?.toISOString() ?? null,
        violationCount: violationMap.get(m.user_id) ?? 0,
        recentViolations: (violationsByUser.get(m.user_id) ?? []).slice(0, 5).map((v) => ({
          source: v.source,
          categories: v.categories,
          confidence: v.confidence,
          autoAction: v.auto_action,
          createdAt: v.created_at.toISOString(),
          messageContent: v.message?.content ?? null,
        })),
      })),
    })
  } catch (err) {
    logger.error("Chat messages fetch error", { error: err instanceof Error ? err.message : String(err) })
    return errorResponse("Internal Server Error", 500)
  }
}
