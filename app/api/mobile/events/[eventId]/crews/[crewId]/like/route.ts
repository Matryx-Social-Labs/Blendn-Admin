import { crewGestureHandler } from "@/lib/crews/like-route"

/**
 * POST /api/mobile/events/:eventId/crews/:crewId/like — like a crew here now:
 * as one of your crews here (`asCrewId`, any present member on the crew's
 * behalf), or as yourself (crew ↔ person, with its guardrails). A like back
 * makes one Blend: `{ liked: true, blend }`. Never says who liked first.
 * Installed builds; new ones wave (`…/wave`).
 */
export const POST = crewGestureHandler(false)
