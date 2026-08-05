import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import slugify from "slugify"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { eventPermissions } from "@/lib/rbac"
import { auditLog } from "@/lib/audit-log"

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
    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
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
    const {
      title,
      description,
      short_description,
      venue_name,
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
    } = body

    // Debug: Log cover_image_url being updated
    logger.info("Updating event - cover_image_url", { error: cover_image_url instanceof Error ? cover_image_url.message : String(cover_image_url) })

    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
      // eventPermissions needs the venue owner: an event at a claimed venue
      // grants that owner operational access even though they cannot edit it.
      include: { venue: { select: { owner_id: true } } },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(session.user, event).canEdit) {
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
    if (current_capacity !== undefined && current_capacity < 0) {
      return new NextResponse("current_capacity cannot be negative", { status: 400 })
    }

    // Fix #35: When cancelling an event, cascade to active check-ins
    const isCancelling = status === "cancelled" && event.status !== "cancelled"

    const updatedEvent = await db.events.update({
      where: { id: resolvedParams.id },
      data: {
        title: title ?? undefined,
        slug: title ? slugify(title, { lower: true, strict: true }) : undefined,
        description: description ?? undefined,
        short_description: short_description ?? undefined,
        venue_name: venue_name ?? undefined,
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
        current_capacity: current_capacity ?? undefined,
        latitude: latitude ?? undefined,
        longitude: longitude ?? undefined,
        cover_image_url: cover_image_url ?? undefined,
        external_link: external_link ?? undefined,
        is_featured: is_featured ?? undefined,
        is_recurring: is_recurring ?? undefined,
        check_in_radius: check_in_radius ?? undefined,
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
      include: { venue: { select: { owner_id: true } } },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    if (!eventPermissions(session.user, event).canEdit) {
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
