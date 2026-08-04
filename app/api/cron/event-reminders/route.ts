import { NextRequest, NextResponse } from "next/server"
import { sendEventReminders } from "@/lib/services/event-notifications.service"

export async function GET(request: NextRequest) {
  // Verify cron secret to prevent unauthorized calls
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const notified = await sendEventReminders(60) // 1 hour before

  return NextResponse.json({
    success: true,
    notified,
    timestamp: new Date().toISOString(),
  })
}
