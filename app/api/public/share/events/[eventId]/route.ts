import type { NextRequest } from "next/server"

import { readShareEvent, serveShare } from "@/lib/share-public"

export const dynamic = "force-dynamic"

/**
 * GET /api/public/share/events/:eventId — what the landing's event page and
 * link-preview card are drawn from. Unauthenticated, server to server, and
 * every reason an event is not readable is one identical 404. Everything that
 * matters is in `lib/share-public.ts`.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params
  return serveShare(req, eventId, readShareEvent)
}
