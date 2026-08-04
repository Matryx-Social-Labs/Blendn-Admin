import { logger } from "@/lib/logger"
import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageEvent } from "@/lib/rbac"
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
    const event = await db.events.findUnique({ where: { id: eventId }, select: { organizer_id: true } })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
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

    const event = await db.events.findUnique({ where: { id: eventId }, select: { organizer_id: true } })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    // Every sponsored message fans out to the whole event chat, so bound how
    // fast one organiser account can create them.
    const limited = rateLimit(req as never, createUserRateLimit("organiser-broadcast", session.user.id))
    if (limited) return limited

    const parsed = sponsoredMessageCreateSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }
    const { content, interval_minutes } = parsed.data

    const message = await db.event_sponsored_messages.create({
      data: {
        event_id: eventId,
        content,
        interval_minutes,
        is_active: false,
      },
    })

    return NextResponse.json(message, { status: 201 })
  } catch (err) {
    logger.error("Error creating sponsored message", { error: err instanceof Error ? err.message : String(err) })
    return new NextResponse("Internal error", { status: 500 })
  }
}
