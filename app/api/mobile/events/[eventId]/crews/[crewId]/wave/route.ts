import { crewGestureHandler } from "@/lib/crews/like-route"

/**
 * POST /api/mobile/events/:eventId/crews/:crewId/wave — "Wave for {crew}"
 * (crews 5-A): as one of your crews here (`asCrewId`), or as yourself. The
 * crew is told ("Nebula waved at your crew", and its card's `wavedAtYou`); a
 * wave or a like back opens the Mix: `{ liked: true, waved: true, blend }`.
 * No push for a single wave. The same body, refusals and limits as `…/like`.
 */
export const POST = crewGestureHandler(true)
