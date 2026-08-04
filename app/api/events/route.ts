import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import slugify from "slugify"

const parseJsonField = (value: unknown) => {
  if (typeof value !== "string") return value
  if (value.trim() === "") return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export async function GET() {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const where: Record<string, unknown> = { deleted_at: null }
    if (session.user.role !== "app_admin") {
      where.organizer_id = session.user.id
    }

    const events = await db.events.findMany({
      where,
      orderBy: { created_at: "desc" },
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

    const event = await db.events.create({
      data: {
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
        check_in_radius,
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

    return NextResponse.json(event)
  } catch (error) {
    logger.error("Error creating event", { error: error instanceof Error ? error.message : String(error) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
