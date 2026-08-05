"use server"

import { revalidatePath } from "next/cache"
import type { moderation_status_type } from "@prisma/client"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"

export interface ModerationRow {
  id: string
  ageHours: number
  excerpt: string
  eventTitle: string
  eventId: string | null
  source: string
  confidence: number | null
  category: string
  autoAction: string | null
  authorName: string
  messageDeleted: boolean
}

/** The pipeline's own act-without-a-human threshold. */
const HIGH_CONFIDENCE = 0.9

/**
 * Pick the worst category out of the moderation payload.
 *
 * `moderation_flags.categories` is free-shaped JSON — OpenAI returns
 * `{hate: 0.92, sexual: 0.1}`, the keyword filter writes its own shape. Rather
 * than trusting one producer's schema, take the highest-scoring numeric key and
 * fall back to the source when there is nothing numeric to rank.
 */
function topCategory(categories: unknown, fallback: string): string {
  if (!categories || typeof categories !== "object") return fallback
  const entries = Object.entries(categories as Record<string, unknown>).filter(
    ([, score]) => typeof score === "number"
  ) as Array<[string, number]>
  if (entries.length === 0) {
    const keys = Object.keys(categories as Record<string, unknown>)
    return keys[0] ?? fallback
  }
  return entries.sort((a, b) => b[1] - a[1])[0][0]
}

export async function getModerationQueue(status: moderation_status_type = "pending") {
  const now = Date.now()

  const [flags, counts] = await Promise.all([
    db.moderation_flags.findMany({
      where: { status },
      // Oldest first: the queue's SLA is how long something has been waiting,
      // so newest-first would bury exactly the items that matter most.
      orderBy: { created_at: "asc" },
      take: 100,
      select: {
        id: true,
        created_at: true,
        source: true,
        confidence: true,
        categories: true,
        auto_action: true,
        user: { select: { name: true, email: true } },
        message: {
          select: {
            content: true,
            deleted_at: true,
            chat_group: { select: { event_id: true, event: { select: { title: true } } } },
          },
        },
      },
    }),
    db.moderation_flags.groupBy({ by: ["status"], _count: { _all: true } }),
  ])

  const rows: ModerationRow[] = flags.map((flag) => ({
    id: flag.id,
    ageHours: Math.floor((now - flag.created_at.getTime()) / (60 * 60 * 1000)),
    excerpt: flag.message.content.slice(0, 140),
    eventTitle: flag.message.chat_group?.event?.title ?? "Unknown event",
    eventId: flag.message.chat_group?.event_id ?? null,
    source: flag.source,
    confidence: flag.confidence,
    category: topCategory(flag.categories, flag.source),
    autoAction: flag.auto_action,
    authorName: flag.user.name ?? flag.user.email,
    messageDeleted: flag.message.deleted_at !== null,
  }))

  return {
    rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Record<
      string,
      number
    >,
    highConfidence: rows.filter((r) => (r.confidence ?? 0) >= HIGH_CONFIDENCE).length,
  }
}

/**
 * Resolve a flag.
 *
 * `approve` keeps the message and clears the flag; `remove` soft-deletes the
 * message. Both write to `audit_logs` — a moderation decision changes what
 * other people can see, so it needs to be attributable after the fact.
 */
export async function resolveFlag(flagId: string, decision: "approve" | "remove") {
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") {
    throw new Error("Only platform admins can resolve moderation flags")
  }

  const flag = await db.moderation_flags.findUnique({
    where: { id: flagId },
    select: { id: true, message_id: true, status: true },
  })
  if (!flag) throw new Error("Flag not found")
  if (flag.status !== "pending") {
    // Two admins working the queue at once would otherwise double-action it.
    throw new Error("This flag has already been reviewed")
  }

  const reviewedStatus: moderation_status_type = decision === "approve" ? "approved" : "rejected"

  await db.$transaction(async (tx) => {
    await tx.moderation_flags.update({
      where: { id: flagId },
      data: {
        status: reviewedStatus,
        reviewed_by: session.user.id,
        reviewed_at: new Date(),
      },
    })
    if (decision === "remove") {
      await tx.chat_messages.update({
        where: { id: flag.message_id },
        data: { deleted_at: new Date() },
      })
    }
  })

  // Fire-and-forget by design (see lib/audit-log.ts): the decision is already
  // committed, so a failed audit write logs and moves on rather than making the
  // admin think their action failed.
  auditLog({
    userId: session.user.id,
    action: decision === "approve" ? "moderation.flag_approved" : "moderation.message_removed",
    resource: "moderation_flag",
    resourceId: flagId,
    details: { messageId: flag.message_id },
  })

  revalidatePath("/dashboard/moderation")
  revalidatePath("/dashboard")
}
