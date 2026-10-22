import type { NextRequest } from "next/server"

import { readShareVenue, serveShare } from "@/lib/share-public"

export const dynamic = "force-dynamic"

/**
 * GET /api/public/share/venues/:venueId — the landing's venue page and card.
 * Unauthenticated, server to server; an unknown, archived or deleted venue is
 * the same 404 as a malformed id. See `lib/share-public.ts`.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params
  return serveShare(req, venueId, readShareVenue)
}
