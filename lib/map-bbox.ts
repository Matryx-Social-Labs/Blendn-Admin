import { z } from "zod"

/**
 * The part of the map on screen, as the lists' `bbox` parameter (backend round 3, SCRUM-1086).
 *
 * The map used to ask with its centre and a radius reaching its corners: a circle around a rectangle, so the count it
 * got back (`pagination.totalCount`) was for more than the view. A box is the view, so its total is the "+130 more ·
 * zoom in" the board draws (pulse-map sheet 10). A box is never a fix: an event's `distance` comes only from `lat`/`lon`.
 *
 * `minLon,minLat,maxLon,maxLat`: GeoJSON's order, which is how a map reports its visible bounds.
 * ponytail: a box across the antimeridian (west > east) is refused; split it into two reads if a market ever sits there.
 */
export type Bbox = { minLon: number; minLat: number; maxLon: number; maxLat: number }

const LAT = z.number().min(-90).max(90)
const LON = z.number().min(-180).max(180)

export const bboxParam = z.string().transform((raw, ctx): Bbox => {
  const parts = raw.split(",").map((p) => (p.trim() === "" ? NaN : Number(p)))
  const [minLon, minLat, maxLon, maxLat] = parts
  const valid =
    parts.length === 4 &&
    LON.safeParse(minLon).success &&
    LON.safeParse(maxLon).success &&
    LAT.safeParse(minLat).success &&
    LAT.safeParse(maxLat).success &&
    minLat <= maxLat &&
    minLon <= maxLon
  if (!valid) {
    ctx.addIssue({ code: "custom", message: "bbox is minLon,minLat,maxLon,maxLat, west to east and south to north." })
    return z.NEVER
  }
  return { minLon, minLat, maxLon, maxLat }
})

export const BBOX_WITH_RADIUS = "Send a bbox or a radius, not both."

/** For a list schema's `refine`: a box and a radius are two shapes of one question. */
export const notBboxAndRadius = (q: { bbox?: Bbox; radius?: number }) => !(q.bbox && q.radius !== undefined)

/** On `(latitude, longitude)`, which events and venues both index. */
export const bboxWhere = (b: Bbox) => ({
  latitude: { gte: b.minLat, lte: b.maxLat },
  longitude: { gte: b.minLon, lte: b.maxLon },
})
