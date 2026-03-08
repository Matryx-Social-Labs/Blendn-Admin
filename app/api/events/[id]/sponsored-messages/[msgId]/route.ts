import { NextResponse } from "next/server"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageEvent } from "@/lib/rbac"
import { sponsoredMessageScheduler } from "@/lib/socket-server"

interface RouteContext {
  params: Promise<{ id: string; msgId: string }>
}

export async function PATCH(req: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId, msgId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { organizer_id: true, chat_group: { select: { id: true } } },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const body = await req.json()
    const { content, interval_minutes, is_active } = body

    const existing = await db.event_sponsored_messages.findFirst({
      where: { id: msgId, event_id: eventId },
    })
    if (!existing) return new NextResponse("Not found", { status: 404 })

    const updated = await db.event_sponsored_messages.update({
      where: { id: msgId },
      data: {
        ...(content !== undefined && { content: content.trim() }),
        ...(interval_minutes !== undefined && { interval_minutes }),
        ...(is_active !== undefined && { is_active }),
        updated_at: new Date(),
      },
    })

    // Sync scheduler
    if (updated.is_active) {
      if (event.chat_group) {
        sponsoredMessageScheduler.start({
          id: updated.id,
          event_id: eventId,
          content: updated.content,
          interval_minutes: updated.interval_minutes,
          organizer_id: event.organizer_id,
          chat_group_id: event.chat_group.id,
        })
      }
    } else {
      sponsoredMessageScheduler.stop(msgId)
    }

    return NextResponse.json(updated)
  } catch (err) {
    console.error("Error updating sponsored message:", err)
    return new NextResponse("Internal error", { status: 500 })
  }
}

export async function DELETE(_: Request, { params }: RouteContext) {
  try {
    const session = await getAuth()
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 })

    const { id: eventId, msgId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { organizer_id: true },
    })
    if (!event) return new NextResponse("Not found", { status: 404 })
    if (!canManageEvent(session.user.role, session.user.id, event.organizer_id)) {
      return new NextResponse("Forbidden", { status: 403 })
    }

    const existing = await db.event_sponsored_messages.findFirst({
      where: { id: msgId, event_id: eventId },
    })
    if (!existing) return new NextResponse("Not found", { status: 404 })

    sponsoredMessageScheduler.stop(msgId)
    await db.event_sponsored_messages.delete({ where: { id: msgId } })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    console.error("Error deleting sponsored message:", err)
    return new NextResponse("Internal error", { status: 500 })
  }
}
