import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import slugify from "slugify"
import { getAuth } from "@/lib/auth"
import { eventWriteSchema } from "@/lib/validations/event"
import { validateLocationInput } from "@/lib/geofence-input"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { auditLog } from "@/lib/audit-log"
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

interface RouteContext {
  params: Promise<{
    id: string
  }>
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const resolvedParams = await params

    /*
     * PATCH and DELETE below both authenticate and run `eventPermissions`.
     * This one did neither, and `middleware.ts` does not match `/api/events`,
     * so it was the only gate and there was none: an unauthenticated GET
     * returned the whole row for any event id, drafts and private events
     * included.
     *
     * The row carries `geofence`, `latitude`/`longitude` and
     * `check_in_radius` -- the server-side check-in boundary. Reading it tells
     * you exactly which coordinates to submit to the mobile check-in route to
     * pass `evaluateCheckIn` from anywhere, which turns the one guarantee the
     * organiser's numbers rest on into a formality.
     */
    const session = await getAuth()
    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      include: {
        venue: { select: { owner_org_id: true } },
      },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canOperate) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    return NextResponse.json(event)
  } catch (error) {
    logger.error("Error fetching event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()

    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    const resolvedParams = await params
    const body = await req.json()

    /*
     * The last write endpoints in the codebase without a schema. The
     * destructure below is an allow-list, so mass assignment was never
     * possible, but nothing bounded a string's length or checked that
     * `latitude` was a number -- and `parseJsonField` put unvalidated
     * `JSON.parse` output into Json columns.
     */
    const parsed = eventWriteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid event payload", issues: parsed.error.issues },
        { status: 400 }
      )
    }
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
      door_policy,
      min_age,
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
    } = parsed.data

    const location = validateLocationInput({ check_in_radius, geofence })
    if (!location.ok) {
      return NextResponse.json({ error: location.error }, { status: 400 })
    }

    // Debug: Log cover_image_url being updated
    logger.info("Updating event - cover_image_url", { coverImageUrl: cover_image_url ?? null })

    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      // eventPermissions needs the venue owner: an event at a claimed venue
      // grants that owner operational access even though they cannot edit it.
      include: { venue: { select: { owner_org_id: true } } },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    // Fix #31: Validate capacity fields on update
    if (max_capacity !== undefined && max_capacity !== null) {
      if (!Number.isInteger(max_capacity) || max_capacity < 1) {
        return new NextResponse("max_capacity must be a positive integer", { status: 400 })
      }
      if (max_capacity > 100_000) {
        return new NextResponse("max_capacity cannot exceed 100,000", { status: 400 })
      }
    }

    // Fix #35: When cancelling an event, cascade to active check-ins
    const isCancelling = status === "cancelled" && event.status !== "cancelled"

    // Omitted means "leave the link alone" — a PATCH that only changes the
    // title must not unlink the venue. Explicit null unlinks.
    const venueLink =
      venue_id === undefined
        ? {}
        : await resolveVenueLink(venue_id, {
            venue_id: event.venue_id,
            venue_link_status: event.venue_link_status,
          })

    const updatedEvent = await db.events.update({
      where: { id: resolvedParams.id },
      data: {
        title: title ?? undefined,
        slug: title ? slugify(title, { lower: true, strict: true }) : undefined,
        description: description ?? undefined,
        short_description: short_description ?? undefined,
        venue_name: venue_name ?? undefined,
        ...venueLink,
        address: address ?? undefined,
        city: city ?? undefined,
        state: state ?? undefined,
        country: country ?? undefined,
        postal_code: postal_code ?? undefined,
        start_time: start_time ? new Date(start_time) : undefined,
        end_time: end_time ? new Date(end_time) : undefined,
        timezone: timezone ?? undefined,
        status: status ?? undefined,
        visibility: visibility ?? undefined,
        max_capacity: max_capacity ?? undefined,
        door_policy: door_policy ?? undefined,
        // `?? undefined` everywhere else in this block means null cannot clear a
        // field. Age restriction is the one that has to be removable — an event
        // that stops being 18+ must be able to say so — so null is written.
        min_age: min_age === undefined ? undefined : min_age,
        latitude: latitude ?? undefined,
        longitude: longitude ?? undefined,
        cover_image_url: cover_image_url ?? undefined,
        external_link: external_link ?? undefined,
        is_featured: is_featured ?? undefined,
        is_recurring: is_recurring ?? undefined,
        check_in_radius: location.values.check_in_radius ?? undefined,
        ...("geofence" in location.values ? { geofence: location.values.geofence ?? undefined } : {}),
        details:
          full_description ||
          house_rules ||
          cancellation_policy ||
          additional_info ||
          faq ||
          accessibility_info ||
          covid_guidelines
            ? {
                upsert: {
                  create: {
                    full_description: full_description || event.description,
                    house_rules,
                    cancellation_policy,
                    additional_info: parseJsonField(additional_info),
                    faq: parseJsonField(faq),
                    accessibility_info: parseJsonField(accessibility_info),
                    covid_guidelines,
                  },
                  update: {
                    full_description: full_description ?? undefined,
                    house_rules: house_rules ?? undefined,
                    cancellation_policy: cancellation_policy ?? undefined,
                    additional_info: parseJsonField(additional_info),
                    faq: parseJsonField(faq),
                    accessibility_info: parseJsonField(accessibility_info),
                    covid_guidelines: covid_guidelines ?? undefined,
                  },
                },
              }
            : undefined,
        categories: Array.isArray(category_ids)
          ? {
              deleteMany: {},
              create:
                category_ids.length > 0
                  ? category_ids.map((categoryId: string, index: number) => ({
                      category: {
                        connect: { id: categoryId },
                      },
                      primary: categoryId === primary_category_id,
                      created_at: new Date(Date.now() + index),
                    }))
                  : [],
            }
          : undefined,
        media: Array.isArray(media_items)
          ? {
              deleteMany: {},
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

    // Reconcile the days whenever the schedule moves. Idempotent — a day that
    // survives the change keeps its id, and therefore its check-ins.
    if (start_time !== undefined || end_time !== undefined || timezone !== undefined) {
      await syncOccurrences(
        updatedEvent.id,
        updatedEvent.start_time,
        updatedEvent.end_time,
        updatedEvent.timezone
      )
    }

    // Fix #35: Cancel all pending/checked_in check-ins when event is cancelled
    if (isCancelling) {
      await db.event_check_ins.updateMany({
        where: {
          event_id: resolvedParams.id,
          status: { in: ["pending", "checked_in"] },
        },
        data: { status: "cancelled", updated_at: new Date() },
      })
    }

    return NextResponse.json(updatedEvent)
  } catch (error) {
    logger.error("Error updating event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function DELETE(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()

    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
    }

    const resolvedParams = await params
    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      // eventPermissions needs the venue owner: an event at a claimed venue
      // grants that owner operational access even though they cannot edit it.
      include: { venue: { select: { owner_org_id: true } } },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(await actorFor(session.user), event).canEdit) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    await db.events.update({
      where: { id: resolvedParams.id },
      data: {
        deleted_at: new Date(),
      },
    })

    auditLog({
      userId: session.user.id,
      action: "delete",
      resource: "event",
      resourceId: resolvedParams.id,
      details: { title: event.title },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    logger.error("Error deleting event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
