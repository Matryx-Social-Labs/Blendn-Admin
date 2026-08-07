import { logger } from "@/lib/logger"
import { NextResponse, type NextRequest } from "next/server"
import { getAuth } from "@/lib/auth"
import { validateLocationInput } from "@/lib/geofence-input"
import { actorFor } from "@/lib/org-membership"
import { db } from "@/lib/db"
import slugify from "slugify"
import { PAGINATION } from "@/lib/constants"
import { resolveVenueLink } from "@/lib/venue-link"
import { syncOccurrences } from "@/lib/occurrences"

const parseJsonField = (value: unknown) => {
  if (typeof value !== "string") return value
  if (value.trim() === "") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export async function GET(req: NextRequest) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    /*
     * Scoped on ORGANISATION MEMBERSHIP, not on who created the row.
     *
     * This was `organizer_id === session.user.id`, which predates the move to
     * organisations and had two consequences nobody would report as a bug: a
     * colleague at the same company saw an empty list because they had not
     * personally created anything, and a venue owner saw nothing at all
     * despite `eventPermissions` granting them operational access to every
     * event in their building.
     *
     * The three clauses mirror `eventPermissions.canOperate` exactly.
     */
    const where: Record<string, unknown> = { deleted_at: null }
    if (session.user.role !== "app_admin") {
      const actor = await actorFor(session.user)
      where.OR = [
        ...(actor.orgIds.length
          ? [
              { organizer_org_id: { in: actor.orgIds } },
              ...(session.user.role === "venue_owner"
                ? [{ venue: { owner_org_id: { in: actor.orgIds } } }]
                : []),
            ]
          : []),
        // Kept so an event created before organisations existed, or by someone
        // whose org link is missing, stays visible to its creator.
        { organizer_id: session.user.id },
      ]
    }

    // Bounded so the payload can't grow without limit as events accumulate.
    // Response stays a plain array — callers can raise the window with ?limit.
    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") || String(PAGINATION.MAX_LIMIT), 10) ||
        PAGINATION.MAX_LIMIT,
      PAGINATION.MAX_LIMIT
    )

    const events = await db.events.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: limit,
    })

    return NextResponse.json(events)
  } catch (error) {
    logger.error("Error fetching events", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getAuth()

    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    const { role } = session.user
    if (role !== "app_admin" && role !== "organizer") {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const body = await req.json()
    const {
      title,
      description,
      short_description,
      venue_name,
      venue_id,
      address,
      city,
      state,
      country,
      postal_code,
      start_time,
      end_time,
      timezone,
      status,
      visibility,
      max_capacity,
      current_capacity,
      latitude,
      longitude,
      cover_image_url,
      external_link,
      is_featured,
      is_recurring,
      check_in_radius,
      full_description,
      house_rules,
      cancellation_policy,
      additional_info,
      faq,
      accessibility_info,
      covid_guidelines,
      category_ids,
      primary_category_id,
      media_items,
      geofence,
    } = body

    // Bounded server-side. This route previously passed check_in_radius from
    // the request body straight into Prisma, so the only limit in the product
    // was a slider in a form — which is a suggestion, not a limit.
    const location = validateLocationInput({ check_in_radius, geofence })
    if (!location.ok) {
      return NextResponse.json({ error: location.error }, { status: 400 })
    }

    // Debug: Log cover_image_url
    logger.info("Creating event - cover_image_url", { error: cover_image_url instanceof Error ? cover_image_url.message : String(cover_image_url) })

    if (!title || !description || !start_time || !end_time || !timezone) {
      return new NextResponse("Missing required fields", { status: 400 })
    }

    // Fix #31: Validate capacity fields
    if (max_capacity !== undefined && max_capacity !== null) {
      if (!Number.isInteger(max_capacity) || max_capacity < 1) {
        return new NextResponse("max_capacity must be a positive integer", { status: 400 })
      }
      if (max_capacity > 100_000) {
        return new NextResponse("max_capacity cannot exceed 100,000", { status: 400 })
      }
    }
    if (current_capacity !== undefined && current_capacity < 0) {
      return new NextResponse("current_capacity cannot be negative", { status: 400 })
    }

    const resolvedFullDescription = full_description || description
    if (!resolvedFullDescription) {
      return new NextResponse("Missing full description", { status: 400 })
    }

    // Derived, never taken from the body — see lib/venue-link.ts.
    const venueLink = await resolveVenueLink(venue_id)

    const event = await db.events.create({
      data: {
        ...venueLink,
        title,
        slug: slugify(title, { lower: true, strict: true }),
        description,
        short_description,
        venue_name,
        address,
        city,
        state,
        country,
        postal_code,
        start_time: new Date(start_time),
        end_time: new Date(end_time),
        timezone,
        status: status ?? "draft",
        visibility: visibility ?? "public",
        max_capacity,
        current_capacity,
        latitude,
        longitude,
        cover_image_url,
        external_link,
        is_featured,
        is_recurring,
        check_in_radius: location.values.check_in_radius ?? undefined,
        geofence: location.values.geofence ?? undefined,
        organizer_id: session.user.id,
        details: {
          create: {
            full_description: resolvedFullDescription,
            house_rules,
            cancellation_policy,
            additional_info: parseJsonField(additional_info),
            faq: parseJsonField(faq),
            accessibility_info: parseJsonField(accessibility_info),
            covid_guidelines,
          },
        },
        categories: Array.isArray(category_ids) && category_ids.length > 0
          ? {
              create: category_ids.map((categoryId: string, index: number) => ({
                category: {
                  connect: { id: categoryId },
                },
                primary: categoryId === primary_category_id,
                created_at: new Date(Date.now() + index),
              })),
            }
          : undefined,
        media: Array.isArray(media_items) && media_items.length > 0
          ? {
              create: media_items.map((item: Record<string, unknown>, index: number) => ({
                type: item.type as "image" | "video" | "document",
                url: item.url as string,
                thumbnail_url: (item.thumbnail_url as string) || undefined,
                title: (item.title as string) || undefined,
                description: (item.description as string) || undefined,
                order:
                  typeof item.order === "number"
                    ? item.order
                    : index,
              })),
            }
          : undefined,
      },
    })

    // Every event has at least one occurrence, and check-in resolves through
    // them — an event created without one could not be checked into at all.
    await syncOccurrences(event.id, new Date(start_time), new Date(end_time), timezone)

    return NextResponse.json(event)
  } catch (error) {
    logger.error("Error creating event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
