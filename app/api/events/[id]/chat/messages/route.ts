import { logger } from "@/lib/logger"
import { errorResponse } from "@/lib/api-response"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { organizer_org_id: true, venue: { select: { owner_org_id: true } }, chat_group: { select: { id: true } } },
    })
    if (!event) return errorResponse("Not found", 404)
    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return errorResponse("Forbidden", 403)
    }
    if (!event.chat_group) return NextResponse.json({ messages: [] })

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
     * Real identity is now admin-only. Hosts get the user id (needed to ban or
     * mute through /chat/members/[userId]) and nothing that names a person.
     */
    // Shaping pinned by __tests__/chat-identity.test.ts — keep them in step.
    const isPlatformAdmin = session.user.role === "app_admin"

    const messages = await db.chat_messages.findMany({
      where: { chat_group_id: event.chat_group.id, deleted_at: null },
      orderBy: { created_at: "desc" },
      take: 100,
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    })

    // Fetch members with banned_by user info
    const members = await db.chat_group_members.findMany({
      where: { chat_group_id: event.chat_group.id },
      select: {
        user_id: true,
        anonymous_name: true,
        status: true,
        banned_at: true,
        banned_by: true,
        updated_at: true,
      },
    })
    const memberMap = new Map(members.map((m) => [m.user_id, m]))

    // Fetch violation counts per user (hidden messages)
    const violationCounts = await db.moderation_flags.groupBy({
      by: ["user_id"],
      where: {
        chat_group_id: event.chat_group.id,
        auto_action: "hidden",
      },
      _count: { id: true },
    })
    const violationMap = new Map(violationCounts.map((v) => [v.user_id, v._count.id]))

    // What is waiting on a human. The feed polls every 5s, so this is the one
    // live number the organiser's screen has for the moderation queue.
    const pendingFlags = await db.moderation_flags.count({
      where: { chat_group_id: event.chat_group.id, status: "pending" },
    })

    // Fetch recent violations for banned/muted users
    const restrictedUserIds = members
      .filter((m) => m.status === "banned" || m.status === "muted")
      .map((m) => m.user_id)

    const recentViolations = restrictedUserIds.length > 0
      ? await db.moderation_flags.findMany({
          where: {
            chat_group_id: event.chat_group.id,
            user_id: { in: restrictedUserIds },
          },
          orderBy: { created_at: "desc" },
          take: 100,
          select: {
            user_id: true,
            source: true,
            categories: true,
            confidence: true,
            auto_action: true,
            created_at: true,
            message: {
              select: { content: true },
            },
          },
        })
      : []

    // Group violations by user
    const violationsByUser = new Map<string, typeof recentViolations>()
    for (const v of recentViolations) {
      const existing = violationsByUser.get(v.user_id) ?? []
      existing.push(v)
      violationsByUser.set(v.user_id, existing)
    }

    // Fetch banned_by user names
    const bannedByIds = [...new Set(members.filter((m) => m.banned_by).map((m) => m.banned_by!))]
    const bannedByUsers = bannedByIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: bannedByIds } },
          select: { id: true, name: true },
        })
      : []
    const bannedByMap = new Map(bannedByUsers.map((u) => [u.id, u.name]))

    return NextResponse.json({
      chatGroupId: event.chat_group.id,
      pendingFlags,
      messages: messages.reverse().map((m) => ({
        id: m.id,
        content: m.content,
        type: m.type,
        createdAt: m.created_at.toISOString(),
        user: {
          id: m.user.id,
          anonymousName: memberMap.get(m.user.id)?.anonymous_name ?? null,
          // Admin-only. Absent, not null, for hosts — so a client that reads
          // `user.name` gets undefined rather than a convincing blank.
          ...(isPlatformAdmin
            ? { name: m.user.name, email: m.user.email, image: m.user.image }
            : {}),
        },
      })),
      members: members.map((m) => ({
        userId: m.user_id,
        anonymousName: m.anonymous_name,
        status: m.status,
        bannedAt: m.banned_at?.toISOString() ?? null,
        bannedByName: m.banned_by ? bannedByMap.get(m.banned_by) ?? null : null,
        mutedAt: m.status === "muted" ? m.updated_at.toISOString() : null,
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
