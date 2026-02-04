import { NextResponse } from "next/server"
import slugify from "slugify"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"

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
    console.error("Error fetching event:", error)
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
    console.log("Updating event - cover_image_url:", cover_image_url)

    const event = await db.events.findFirst({
      where: {
        id: resolvedParams.id,
        deleted_at: null,
      },
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

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

    return NextResponse.json(updatedEvent)
  } catch (error) {
    console.error("Error updating event:", error)
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
    })

    if (!event) {
      return new NextResponse("Event not found", { status: 404 })
    }

    await db.events.update({
      where: { id: resolvedParams.id },
      data: {
        deleted_at: new Date(),
      },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error("Error deleting event:", error)
    return new NextResponse("Internal error", { status: 500 })
  }
}
