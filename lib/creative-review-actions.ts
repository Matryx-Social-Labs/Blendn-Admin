"use server"

import { revalidatePath } from "next/cache"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"

/**
 * Reviewing sponsored copy before it enters a room.
 *
 * ## Why this has to exist for anything else to work
 *
 * `canActivate` refuses unless `moderation_status` is `approved`, and the column
 * defaults to `pending` on both the campaign and every creative revision. So
 * without a screen that sets it, every sponsored campaign ever created is
 * permanently un-switchable — the feature would have shipped complete and inert,
 * which is the failure mode this branch has already produced five times.
 *
 * ## Why a rejection stops a live campaign
 *
 * The old scheduler captured the copy in a closure and re-armed on any activating
 * PATCH. A rejection wrote the status and nothing else, so a creative that had
 * just been refused kept firing every interval until someone noticed. Rejecting
 * here clears `is_active` and `next_send_at` in the same transaction: the point
 * of refusing is that it stops.
 *
 * ## Why the campaign's status only follows the LATEST revision
 *
 * `event_sponsored_messages.moderation_status` is a denormalisation of "may the
 * current creative run", kept on the campaign because it is read on every
 * activation and every scheduler pass. Approving an older revision must not
 * un-pend a newer one that is still waiting — otherwise a reviewer working
 * bottom-up through a queue silently approves copy they have not read.
 */

export interface CreativeQueueRow {
  id: string
  campaignId: string
  eventId: string
  eventTitle: string
  eventStart: Date
  content: string
  mediaUrl: string | null
  mediaType: string | null
  brandName: string | null
  ownerName: string | null
  /** False for a superseded revision — it can be skipped. */
  isLatest: boolean
  /** True when the campaign is live and this is what is running. */
  campaignActive: boolean
  /** A previous revision of the same campaign was already refused. */
  hadRejection: boolean
  createdAt: Date
}

export async function getCreativeQueue(): Promise<CreativeQueueRow[]> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

  const rows = await db.sponsored_creatives.findMany({
    where: { moderation_status: "pending" },
    // Oldest first: age is the SLA here as it is everywhere else in moderation.
    orderBy: { created_at: "asc" },
    select: {
      id: true,
      content: true,
      media_url: true,
      media_type: true,
      created_at: true,
      message: {
        select: {
          id: true,
          is_active: true,
          event: { select: { id: true, title: true, start_time: true } },
          sponsor: {
            select: { name: true, org: { select: { display_name: true } } },
          },
          creatives: {
            select: { id: true, created_at: true, moderation_status: true },
            orderBy: { created_at: "desc" },
          },
        },
      },
    },
  })

  return rows.map((r) => ({
    id: r.id,
    campaignId: r.message.id,
    eventId: r.message.event.id,
    eventTitle: r.message.event.title,
    eventStart: r.message.event.start_time,
    content: r.content,
    mediaUrl: r.media_url,
    mediaType: r.media_type,
    brandName: r.message.sponsor?.name ?? null,
    ownerName: r.message.sponsor?.org?.display_name ?? null,
    isLatest: r.message.creatives[0]?.id === r.id,
    campaignActive: r.message.is_active,
    /*
     * Shown because it changes how the copy reads. A third attempt at wording
     * that was refused twice is a different review from a first submission, and
     * the reviewer cannot see the history from the text alone.
     */
    hadRejection: r.message.creatives.some(
      (c) => c.id !== r.id && c.moderation_status === "rejected"
    ),
    createdAt: r.created_at,
  }))
}

export async function decideCreative(
  creativeId: string,
  decision: "approve" | "reject",
  note?: string
): Promise<void> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  const admin = session.user

  const trimmed = note?.trim() ?? ""
  // A refusal with no reason produces an identical resubmission, and the queue
  // gets the same words again.
  if (decision === "reject" && trimmed.length < 10) {
    throw new Error("Give a reason — the organiser has to know what to change.")
  }

  const creative = await db.sponsored_creatives.findUnique({
    where: { id: creativeId },
    select: {
      id: true,
      moderation_status: true,
      message: {
        select: {
          id: true,
          event_id: true,
          sponsor_id: true,
          creatives: { select: { id: true }, orderBy: { created_at: "desc" }, take: 1 },
        },
      },
    },
  })
  if (!creative) throw new Error("Creative not found")
  if (creative.moderation_status !== "pending") {
    throw new Error("This creative has already been reviewed.")
  }

  const isLatest = creative.message.creatives[0]?.id === creative.id
  const status = decision === "approve" ? "approved" : "rejected"

  await db.$transaction(async (tx) => {
    await tx.sponsored_creatives.update({
      where: { id: creativeId },
      data: {
        moderation_status: status,
        approved_by: decision === "approve" ? admin.id : null,
        approved_at: decision === "approve" ? new Date() : null,
      },
    })

    if (!isLatest) return

    await tx.event_sponsored_messages.update({
      where: { id: creative.message.id },
      data: {
        moderation_status: status,
        /*
         * A refusal stops the campaign. Approving does NOT start it — the
         * organiser decides when it runs, and switching on somebody else's
         * campaign because the copy passed review is not a reviewer's call.
         */
        ...(decision === "reject"
          ? {
              is_active: false,
              next_send_at: null,
              claim_token: null,
              claimed_at: null,
              deactivated_reason: "Creative was not approved.",
            }
          : {}),
      },
    })
  })

  auditLog({
    userId: admin.id,
    action: decision === "approve" ? "creative.approved" : "creative.rejected",
    resource: "sponsored_creatives",
    resourceId: creativeId,
    details: {
      campaignId: creative.message.id,
      eventId: creative.message.event_id,
      sponsorId: creative.message.sponsor_id,
      wasLatest: isLatest,
      note: trimmed || null,
    },
  })

  revalidatePath("/dashboard/creative-review")
}
