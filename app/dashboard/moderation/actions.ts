"use server"

import { revalidatePath } from "next/cache"
import type { moderation_status_type } from "@prisma/client"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { trustSignalsFor } from "@/lib/trust"

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
  /**
   * What is known about the person, not just the message.
   *
   * `ROADMAP.md` names accountability as the differentiator — a GPS-verified
   * human behind every pseudonym — and a moderator was shown neither. The band
   * and the harassment count are the two facts that change a decision; the
   * average is deliberately absent, because a moderator does not need a score
   * and a score invites one to be shown to somebody else later.
   */
  trust: { band: string; ratings: number; harassment: number }
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

/** One page of the queue. The screen says how many there are; see `total`. */
const QUEUE_PAGE = 100

export async function getModerationQueue(status: moderation_status_type = "pending") {
  // The screen this feeds is app_admin-only and `resolveFlag` below checks for
  // it. The read half did not, and it is the half that returns the sensitive
  // data: private chat message content paired with the author's real name and
  // email, for every flagged message on the platform. The page's redirect
  // guards the view, not this endpoint.
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") throw new Error("Not authorised")

  const now = Date.now()

  const [flags, counts, uncheckedLastHour, highConfidence] = await Promise.all([
    db.moderation_flags.findMany({
      where: { status },
      // Oldest first: the queue's SLA is how long something has been waiting,
      // so newest-first would bury exactly the items that matter most.
      orderBy: { created_at: "asc" },
      take: QUEUE_PAGE,
      select: {
        id: true,
        created_at: true,
        source: true,
        confidence: true,
        categories: true,
        auto_action: true,
        // The id as well as the name: the trust lookup groups by it, and a name
        // is not a key.
        user_id: true,
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
    /*
     * How many messages were **delivered without being examined** in the last
     * hour.
     *
     * The point of the `unchecked` state. Previously the pipeline wrote
     * `moderation_status: "clean"` whether or not the model had been reached,
     * so a moderator could not distinguish a quiet room from a pipeline that
     * had been down for a week -- and `OPENAI_API_KEY` is optional, so "down"
     * is the ordinary configuration.
     *
     * An hour rather than all time: this is a health signal, and a total would
     * accumulate a number nobody could act on.
     */
    db.chat_messages.count({
      where: {
        moderation_status: "unchecked",
        created_at: { gte: new Date(now - 60 * 60 * 1000) },
      },
    }),

    /*
     * Counted in the database, not over the page.
     *
     * This was `rows.filter(...).length` — the high-confidence count of the
     * first hundred flags, rendered as the high-confidence count of the queue.
     * With more than a page waiting it under-reports exactly when the queue is
     * busiest, which is when the number is read.
     */
    db.moderation_flags.count({
      where: { status, confidence: { gte: HIGH_CONFIDENCE } },
    }),
  ])

  /*
   * What the moderator is actually deciding about.
   *
   * A queue row is a message and a name. The plan's argument for peer ratings
   * is that the substrate exists and is unused: a moderator could see that this
   * person has been rated by four people who physically met them, and that one
   * of them reported harassment. `getTrustSignal` was written for exactly this,
   * and `trust-not-exposed.test.ts` states in prose that "moderation reads it
   * through the dashboard" — which was false, because it had no caller at all.
   *
   * One query for the whole page, not one per row: `peer_ratings` is grouped by
   * the people appearing on this page rather than fetched per flag, so a
   * hundred-row queue costs one round trip.
   *
   * Staff-only by construction — this is a dashboard action behind an
   * `app_admin` check, and the mobile surface is forbidden from touching the
   * module by a test that scans every file under `app/api/mobile`.
   */
  const authorIds = flags.map((f) => f.user_id)
  const trustOf = await trustSignalsFor(authorIds)

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
    /*
     * The band, never the average, and the count so the band can be weighed.
     *
     * `trustBand` returns `unrated` below `MIN_RATINGS`, which is what stops a
     * single bad night from reading as a pattern. A harassment report is
     * surfaced on its own regardless of volume — the schema's own rule, and the
     * reason it is a separate field rather than folded into the score.
     */
    trust: {
      band: trustOf.get(flag.user_id)?.band ?? "unrated",
      ratings: trustOf.get(flag.user_id)?.ratings ?? 0,
      harassment: trustOf.get(flag.user_id)?.issues.harassment ?? 0,
    },
  }))

  return {
    rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Record<
      string,
      number
    >,
    highConfidence,
    uncheckedLastHour,
    /*
     * How many are actually waiting, so the page can say the list is a page.
     *
     * Free: `counts` is already a per-status count for the tabs, so the total
     * for the active tab is one lookup rather than another query.
     */
    total: Object.fromEntries(counts.map((c) => [c.status, c._count._all]))[status] ?? rows.length,
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
        data: { moderation_status: "hidden", deleted_at: new Date() },
      })
    } else {
      /*
       * "Keep" has to actually keep it.
       *
       * This set the flag approved and never touched the message, so an
       * auto-hidden message stayed soft-deleted with `moderation_status:
       * "hidden"` and no path back -- while the toast said *"message kept"*.
       * The flag left the queue, so nobody would ever look at it again either.
       *
       * The organiser's twin at `app/api/events/[id]/chat/moderation/[flagId]`
       * has always restored correctly. Two screens deciding one thing, and the
       * one an admin uses was the wrong one.
       *
       * `clean` rather than `unchecked`: a human looked, which is a stronger
       * verdict than the model's, and it is the same value the twin writes.
       */
      await tx.chat_messages.update({
        where: { id: flag.message_id },
        data: { moderation_status: "clean", deleted_at: null },
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
