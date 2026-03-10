import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(
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
      select: { id: true, title: true, organizer_id: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Only organiser or admin can export
    if (event.organizer_id !== authUser.userId) {
      const user = await db.user.findUnique({
        where: { id: authUser.userId },
        select: { role: true },
      })
      if (user?.role !== "app_admin") {
        return forbiddenResponse("Only the event organiser can export attendees")
      }
    }

    const checkIns = await db.event_check_ins.findMany({
      where: { event_id: eventId },
      include: {
        user: {
          select: {
            name: true,
            email: true,
            profile: {
              select: { phone: true },
            },
          },
        },
      },
      orderBy: { check_in_time: "asc" },
    })

    // Build CSV
    const headers = ["Name", "Email", "Phone", "Status", "Check-in Time", "Check-out Time"]
    const rows = checkIns.map((ci) => [
      escapeCsv(ci.user.name || ""),
      escapeCsv(ci.user.email),
      escapeCsv(ci.user.profile?.phone || ""),
      ci.status,
      ci.check_in_time ? ci.check_in_time.toISOString() : "",
      ci.check_out_time ? ci.check_out_time.toISOString() : "",
    ])

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n")

    const safeTitle = event.title.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeTitle}_attendees.csv"`,
      },
    })
  } catch (error) {
    console.error("Export attendees error:", error)
    return serverErrorResponse("Failed to export attendees")
  }
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
