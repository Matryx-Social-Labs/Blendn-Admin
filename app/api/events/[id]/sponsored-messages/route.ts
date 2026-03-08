import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageEvent } from "@/lib/rbac"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_: Request, { params }: RouteContext) {
  try {
    const { id: eventId } = await params
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })
    const event = await db.events.findUnique({ where: { id: eventId }, select: { organizer_id: true } })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const messages = await db.event_sponsored_messages.findMany({
      where: { event_id: eventId },
      orderBy: { created_at: "asc" },
    })

    return NextResponse.json(messages)
  } catch (err) {
    console.error("Error fetching sponsored messages:", err)
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function POST(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId } = await params

    const event = await db.events.findUnique({ where: { id: eventId }, select: { organizer_id: true } })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const { content, interval_minutes } = await req.json()

    if (!content?.trim()) {
      return new NextResponse("content is required", { status: 400 })
    }

    const intervals = [10, 15, 30, 60]
    if (!intervals.includes(interval_minutes)) {
      return new NextResponse("interval_minutes must be 10, 15, 30 or 60", { status: 400 })
    }

    const message = await db.event_sponsored_messages.create({
      data: {
        event_id: eventId,
        content: content.trim(),
        interval_minutes,
        is_active: false,
      },
    })

    return NextResponse.json(message, { status: 201 })
  } catch (err) {
    console.error("Error creating sponsored message:", err)
    return new NextResponse("Internal error", { status: 500 })
  }
}
