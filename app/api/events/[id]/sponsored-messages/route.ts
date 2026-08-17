import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canBroadcast, eventPermissions } from "@/lib/rbac"
import { actorFor, resolveSponsorGrant } from "@/lib/org-membership"
import { rateLimit, createUserRateLimit } from "@/lib/rate-limit"
import { sponsoredMessageCreateSchema } from "@/lib/validations/event"
import { PAGINATION } from "@/lib/constants"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const { id: eventId } = await params
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })
    const event = await db.events.findUnique({ where: { id: eventId }, select: { organizer_org_id: true, venue: { select: { owner_org_id: true } } } })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const messages = await db.event_sponsored_messages.findMany({
      where: { event_id: eventId },
      orderBy: { created_at: "asc" },
      take: PAGINATION.MAX_LIMIT,
    })

    return NextResponse.json(messages)
  } catch (err) {
    logger.error("Error fetching sponsored messages", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function POST(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId } = await params

    const event = await db.events.findUnique({ where: { id: eventId }, select: { organizer_org_id: true, venue: { select: { owner_org_id: true } } } })
    if (!event) return new NextResponse("Not found", { status: 404 })

    /*
     * `canBroadcast`, not `canEdit`.
     *
     * "Sponsored" is a claim that somebody paid. `lib/rbac.ts:191` gates it
     * behind `organisations.may_sponsor` for exactly that reason, and
     * `__tests__/broadcast-permissions.test.ts` pins all twenty rows of that
     * table — but this route, the one the dashboard actually uses, checked
     * `canEdit` and never called the resolver at all. So the scarcity rule was
     * enforced on the mobile announce path and nowhere else, and any organiser
     * could label their own content as paid placement and have the scheduler
     * fan it into the room on a timer.
     *
     * One error for both refusals, deliberately: naming the flag tells an
     * attacker which one to go after, and tells an organiser about a capability
     * they cannot self-serve.
     */
    const actor = await actorFor(session.user)
    const grant = await resolveSponsorGrant(actor, eventId)
    if (!canBroadcast(actor, event, "sponsored", grant ?? undefined)) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    // Every sponsored message fans out to the whole event chat, so bound how
    // fast one organiser account can create them.
    const limited = await rateLimit(req as never, createUserRateLimit("organiser-broadcast", session.user.id))
    if (limited) return limited

    const parsed = sponsoredMessageCreateSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }
    const { content, interval_minutes, sponsor_id } = parsed.data

    /*
     * The brand in the body must be the brand this actor is entitled to place.
     *
     * `resolveSponsorGrant` above proves *an* organisation of theirs has
     * `may_sponsor` and an approved placement here. It says nothing about which
     * brand `sponsor_id` names, so without this an org with one legitimate
     * placement could file campaigns under any other brand on the platform —
     * the same confused-deputy shape the grant tuple exists to close.
     *
     * An admin has no grant by design, so for them the placement alone is the
     * check.
     */
    const placement = await db.event_sponsors.findFirst({
      where: {
        event_id: eventId,
        sponsor_id,
        status: "approved",
        sponsor: {
          deleted_at: null,
          merged_into: null,
          ...(grant ? { org_id: grant.orgId } : {}),
        },
      },
      select: { id: true },
    })
    if (!placement) return new NextResponse("Forbidden", { status: 403 })

    /*
     * Campaign and first creative together.
     *
     * `sponsored_creatives` is what a send records against, so a campaign with
     * no creative row is one the scheduler skips — and `moderation_status`
     * defaults to `pending` on both, which is the correct starting state: no
     * copy has been reviewed yet.
     */
    const message = await db.$transaction(async (tx) => {
      const created = await tx.event_sponsored_messages.create({
        data: {
          event_id: eventId,
          sponsor_id,
          content,
          interval_minutes,
          is_active: false,
        },
      })
      await tx.sponsored_creatives.create({
        data: { message_id: created.id, content },
      })
      return created
    })

    return NextResponse.json(message, { status: 201 })
  } catch (err) {
    logger.error("Error creating sponsored message", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
