import { logger } from "@/lib/logger"
import { errorResponse } from "@/lib/api-response"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canBroadcast, eventPermissions } from "@/lib/rbac"
import { actorFor, resolveSponsorGrant } from "@/lib/org-membership"
import { firstWindow } from "@/lib/sponsored-scheduler"
import { sponsoredMessageUpdateSchema } from "@/lib/validations/event"
import { canActivate, creativeEditPatch, touchesCreative } from "@/lib/sponsored-moderation"

interface RouteContext {
  params: Promise<{ id: string; msgId: string }>
}

export async function PATCH(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId, msgId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { organizer_id: true, organizer_org_id: true, venue: { select: { owner_org_id: true } }, chat_group: { select: { id: true } } },
    })
    if (!event) return errorResponse("Not found", 404)

    /*
     * `canBroadcast`, not `canEdit` — and this is the handler where it matters
     * most, because setting `is_active` here is what arms
     * the schedule and starts the fan-out into the room. See the
     * note on the POST handler in ../route.ts.
     */
    const actor = await actorFor(session.user)
    if (!canBroadcast(actor, event, "sponsored", (await resolveSponsorGrant(actor, eventId)) ?? undefined)) {
      return errorResponse("Forbidden", 403)
    }

    const parsed = sponsoredMessageUpdateSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }
    const { content, interval_minutes, is_active } = parsed.data

    const existing = await db.event_sponsored_messages.findFirst({
      where: { id: msgId, event_id: eventId },
    })
    if (!existing) return errorResponse("Not found", 404)

    /*
     * An edit to the creative is a NEW creative, and cannot inherit approval.
     *
     * This route re-armed the scheduler on any PATCH where `is_active` was
     * true, reading the content it had just written. So "create clean, get
     * approved, activate, then edit the words" put unreviewed text into the
     * room within one interval with the approval still attached — the gate was
     * decorative for anyone who could edit.
     *
     * Changing only the interval is deliberately NOT an edit: nobody has
     * changed a word of what runs, and sending them back through review for a
     * schedule change teaches people to route around review.
     */
    const editsCreative = touchesCreative({ content }, existing)

    /*
     * Refuse the activation rather than silently ignoring it.
     *
     * Previously, activating with no chat group wrote `is_active: true`,
     * returned 200, and scheduled nothing — the switch said on, the toast said
     * "Started sending", and no message ever went out. An impossible state
     * should be unreachable, not reported as success.
     */
    if (is_active === true && !editsCreative) {
      const placement = existing.sponsor_id
        ? await db.event_sponsors.findFirst({
            where: { event_id: eventId, sponsor_id: existing.sponsor_id },
            select: { status: true },
          })
        : null

      const decision = canActivate({
        moderation_status: existing.moderation_status,
        sponsor_id: existing.sponsor_id,
        hasChatGroup: Boolean(event.chat_group),
        placementApproved: placement?.status === "approved",
      })
      if (!decision.allowed) {
        return NextResponse.json({ error: decision.reason }, { status: 409 })
      }
    }

    /*
     * `next_send_at` IS the schedule now — there is no timer to arm.
     *
     * Switching on sets it to `firstWindow()`, which is *now*: the old
     * `setInterval` had no leading edge, so flipping the switch bought an
     * interval of silence and read as a broken control. Switching off clears it,
     * along with any claim a worker holds, so a pass already in flight finds
     * nothing to finalize.
     *
     * `deactivated_reason` is cleared on activation. It records why the
     * SCHEDULER gave up, and leaving a stale one on a live campaign shows the
     * organiser a reason for a state it is no longer in.
     */
    const schedule =
      is_active === true && !editsCreative
        ? {
            next_send_at: firstWindow(),
            consecutive_failures: 0,
            deactivated_reason: null,
            claim_token: null,
            claimed_at: null,
          }
        : is_active === false || editsCreative
          ? { next_send_at: null, claim_token: null, claimed_at: null }
          : {}

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.event_sponsored_messages.update({
        where: { id: msgId },
        data: {
          ...(content !== undefined && { content }),
          ...(interval_minutes !== undefined && { interval_minutes }),
          ...(is_active !== undefined && { is_active }),
          // One write, not two. Applying the reset separately would leave a
          // window where the content is new and the approval is old.
          ...(editsCreative ? creativeEditPatch() : {}),
          ...schedule,
          updated_at: new Date(),
        },
      })

      /*
       * A new revision, not an edit in place.
       *
       * `sponsored_message_sends.creative_id` is `onDelete: Restrict` precisely
       * so history survives: a send from last night must keep pointing at the
       * words it actually delivered. Rewriting the existing creative row would
       * retroactively change what a past send says it sent.
       */
      if (editsCreative) {
        await tx.sponsored_creatives.create({
          data: { message_id: msgId, content: row.content },
        })
      }

      return row
    })

    return NextResponse.json(updated)
  } catch (err) {
    logger.error("Error updating sponsored message", { error: err instanceof Error ? err.message : String(err) })
    return errorResponse("Internal error", 500)
  }
}

export async function DELETE(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return errorResponse("Unauthorized", 401)

    const { id: eventId, msgId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { organizer_id: true, organizer_org_id: true, venue: { select: { owner_org_id: true } } },
    })
    if (!event) return errorResponse("Not found", 404)
    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return errorResponse("Forbidden", 403)
    }

    const existing = await db.event_sponsored_messages.findFirst({
      where: { id: msgId, event_id: eventId },
    })
    if (!existing) return errorResponse("Not found", 404)

    // No timer to stop — deleting the row deletes the schedule with it.
    await db.event_sponsored_messages.delete({ where: { id: msgId } })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    logger.error("Error deleting sponsored message", { error: err instanceof Error ? err.message : String(err) })
    return errorResponse("Internal error", 500)
  }
}
