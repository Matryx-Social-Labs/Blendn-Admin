import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import slugify from "slugify"

export async function GET() {
  try {
    const events = await db.events.findMany({
      where: {
        deleted_at: null,
      },
      orderBy: {
        created_at: "desc",
      },
    })

    return NextResponse.json(events)
  } catch (error) {
    console.error("Error fetching events:", error)
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getAuth()

    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 })
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
      max_capacity,
      external_link,
    } = body

    if (!title || !description || !start_time || !end_time || !timezone) {
      return new NextResponse("Missing required fields", { status: 400 })
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
        max_capacity,
        external_link,
        organizer_id: session.user.id,
        status: "draft",
      },
    })

    return NextResponse.json(event)
  } catch (error) {
    console.error("Error creating event:", error)
    return new NextResponse("Internal error", { status: 500 })
  }
}
