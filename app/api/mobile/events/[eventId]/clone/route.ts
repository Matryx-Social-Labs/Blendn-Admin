import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { owningOrgFor } from "@/lib/event-ownership"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { actorFor } from "@/lib/org-membership"
import { eventPermissions } from "@/lib/rbac"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { randomUUID } from "crypto"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("heavy", "event-clone", authUser.userId))
    if (limited) return limited

    const { eventId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      include: {
        details: true,
        categories: { select: { category_id: true, primary: true } },
        media: { select: { type: true, url: true, thumbnail_url: true, title: true, description: true, order: true } },
        // `include` returns every scalar, so `organizer_org_id` is already
        // here — but `venue` is a relation and the resolver reads it.
        venue: { select: { owner_org_id: true } },
      },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    /*
     * `canEdit`, not `canOperate`.
     *
     * The audit register proposed `canOperate` for this route alongside
     * analytics and the attendee export. That is wrong for clone specifically:
     * cloning copies the title, description, details, categories and media into
     * a NEW event owned by the caller. `canOperate` is "what happens in your
     * building" and it includes venue owners — a venue owner being able to
     * duplicate an organiser's event as their own is not the same permission as
     * moderating that event's room. Taking someone's content is an `canEdit`
     * act even though it writes a different row.
     */
    const requester = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, role: true },
    })
    if (!requester) return forbiddenResponse("You cannot clone this event")

    const actor = await actorFor({ id: requester.id, role: requester.role })
    if (!eventPermissions(actor, event).canEdit) {
      return forbiddenResponse("You cannot clone this event")
    }

    const newSlug = `${event.slug}-copy-${Date.now()}`

    const cloned = await db.events.create({
      data: {
        title: `${event.title} (Copy)`,
        slug: newSlug,
        description: event.description,
        short_description: event.short_description,
        latitude: event.latitude,
        longitude: event.longitude,
        address: event.address,
        venue_name: event.venue_name,
        city: event.city,
        state: event.state,
        country: event.country,
        postal_code: event.postal_code,
        start_time: event.start_time,
        end_time: event.end_time,
        timezone: event.timezone,
        status: "draft",
        visibility: event.visibility,
        max_capacity: event.max_capacity,
        organizer_id: authUser.userId,
        /*
         * The clone was landing org-less. A comment above this route claims
         * "`include` returns every scalar, so `organizer_org_id` is already
         * here" -- true of the read, and the create below never copied it. So
         * cloning produced an event its own cloner could not edit, and which
         * every org-scoped dashboard listing and report silently excluded.
         *
         * Resolved from the cloner rather than copied from the source: cloning
         * somebody else's event makes it yours, and inheriting their org would
         * hand them edit rights over your copy.
         */
        organizer_org_id: await owningOrgFor({ id: requester.id, role: requester.role }),
        cover_image_url: event.cover_image_url,
        external_link: event.external_link,
        is_featured: false,
        is_recurring: event.is_recurring,
        check_in_radius: event.check_in_radius,
        categories: {
          create: event.categories.map((c) => ({
            category_id: c.category_id,
            primary: c.primary,
          })),
        },
        media: {
          create: event.media.map((m) => ({
            id: randomUUID(),
            type: m.type,
            url: m.url,
            thumbnail_url: m.thumbnail_url,
            title: m.title,
            description: m.description,
            order: m.order,
          })),
        },
        ...(event.details && {
          details: {
            create: {
              full_description: event.details.full_description,
              house_rules: event.details.house_rules,
              cancellation_policy: event.details.cancellation_policy,
              additional_info: event.details.additional_info ?? undefined,
              faq: event.details.faq ?? undefined,
              accessibility_info: event.details.accessibility_info ?? undefined,
              covid_guidelines: event.details.covid_guidelines,
            },
          },
        }),
      },
      select: { id: true, slug: true, title: true, status: true },
    })

    return successResponse(cloned, 201)
  } catch (error) {
    logger.error("Clone event error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to clone event")
  }
}
