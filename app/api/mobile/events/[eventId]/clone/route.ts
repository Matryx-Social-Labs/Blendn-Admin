import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
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

    const { eventId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      include: {
        details: true,
        categories: { select: { category_id: true, primary: true } },
        media: { select: { type: true, url: true, thumbnail_url: true, title: true, description: true, order: true } },
      },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Only organiser or admin can clone
    if (event.organizer_id !== authUser.userId) {
      const user = await db.user.findUnique({
        where: { id: authUser.userId },
        select: { role: true },
      })
      if (user?.role !== "app_admin") {
        return forbiddenResponse("Only the event organiser can clone this event")
      }
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
        current_capacity: 0,
        organizer_id: authUser.userId,
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
