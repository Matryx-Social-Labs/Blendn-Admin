import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canBroadcast, eventPermissions } from "@/lib/rbac"
import { actorFor, resolveSponsorGrant } from "@/lib/org-membership"
import { sponsoredMessageScheduler } from "@/lib/socket-server"
import { sponsoredMessageUpdateSchema } from "@/lib/validations/event"
import { canActivate, creativeEditPatch, touchesCreative } from "@/lib/sponsored-moderation"

interface RouteContext {
  params: Promise<{ id: string; msgId: string }>
}

export async function PATCH(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId, msgId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { organizer_id: true, organizer_org_id: true, venue: { select: { owner_org_id: true } }, chat_group: { select: { id: true } } },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })

    /*
     * `canBroadcast`, not `canEdit` — and this is the handler where it matters
     * most, because setting `is_active` here is what arms
     * `sponsoredMessageScheduler` and starts the fan-out into the room. See the
     * note on the POST handler in ../route.ts.
     */
    const actor = await actorFor(session.user)
    if (!canBroadcast(actor, event, "sponsored", (await resolveSponsorGrant(actor, eventId)) ?? undefined)) {
      return new NextResponse("Forbidden", { status: 403 })
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
    if (!existing) return new NextResponse("Not found", { status: 404 })

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

    const updated = await db.event_sponsored_messages.update({
      where: { id: msgId },
      data: {
        ...(content !== undefined && { content }),
        ...(interval_minutes !== undefined && { interval_minutes }),
        ...(is_active !== undefined && { is_active }),
        // One write, not two. Applying the reset separately would leave a
        // window where the content is new and the approval is old.
        ...(editsCreative ? creativeEditPatch() : {}),
        updated_at: new Date(),
      },
    })

    // Sync scheduler
    if (updated.is_active) {
      if (event.chat_group) {
        sponsoredMessageScheduler.start({
          id: updated.id,
          event_id: eventId,
          content: updated.content,
          interval_minutes: updated.interval_minutes,
          organizer_id: event.organizer_id,
          chat_group_id: event.chat_group.id,
        })
      }
    } else {
      sponsoredMessageScheduler.stop(msgId)
    }

    return NextResponse.json(updated)
  } catch (err) {
    logger.error("Error updating sponsored message", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function DELETE(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId, msgId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { organizer_id: true, organizer_org_id: true, venue: { select: { owner_org_id: true } } },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const existing = await db.event_sponsored_messages.findFirst({
      where: { id: msgId, event_id: eventId },
    })
    if (!existing) return new NextResponse("Not found", { status: 404 })

    sponsoredMessageScheduler.stop(msgId)
    await db.event_sponsored_messages.delete({ where: { id: msgId } })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    logger.error("Error deleting sponsored message", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
