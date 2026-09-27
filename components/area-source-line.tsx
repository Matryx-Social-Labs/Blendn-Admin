import type { Geofence } from "@/lib/geofence"

/** Where the check-in area came from. */
export type AreaSource = "venue" | "venue-pin" | "osm-area" | "building" | "circle" | "drawn"

/** Whose the buffer is, in the words each screen uses for it. */
export type BufferWhose = "venue" | "default" | "custom" | "every-event"

const BUFFER_SAID: Record<BufferWhose, string> = {
  venue: "the venue's buffer",
  default: "the default buffer",
  custom: "custom for this event",
  // The venue pages (SCRUM-354): the number the event form shows as "Venue's · N m".
  "every-event": "the default every event here starts with",
}

/**
 * The area cites its source — the memorable detail of the event form's Where
 * (SCRUM-353) and of the venue pages' Location (SCRUM-354). One line under the
 * map, like a citation: where the outline came from, its size, and whose the
 * buffer is. A circle that stands in for a missing outline says so, in the
 * warning tone, and asks for the building.
 *
 * `saved` names an area nobody picked in this visit: the event's own, or the
 * venue's.
 */
export function AreaSourceLine({
  source,
  fence,
  whose,
  saved = "The event's saved area",
}: {
  source: AreaSource | null
  fence: Geofence | null
  whose: BufferWhose
  saved?: string
}) {
  if (!fence) return null
  const shape =
    fence.type === "polygon" ? `${fence.ring.length} corners` : `a ${Math.round(fence.radius)} m circle`
  const buffer = `+${fence.buffer} m, ${BUFFER_SAID[whose]}`
  const said: Record<AreaSource, string> = {
    venue: "Area from the venue",
    "venue-pin": "The venue has no outline yet",
    "osm-area": "Outline from OpenStreetMap",
    building: "Building outline found nearby",
    circle: "No outline in OpenStreetMap",
    drawn: "Drawn on the map",
  }
  const warn = source === "circle" || source === "venue-pin"
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]" data-area-source={source ?? "saved"}>
      <span className={warn ? "size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-warning" : "size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-primary"} aria-hidden />
      <span className={warn ? "font-medium text-warning" : "font-medium"}>{source ? said[source] : saved}</span>
      <span className="text-muted-foreground">
        · {warn ? `${shape} at the address — adjust the area to draw the building` : shape} · {buffer}
      </span>
    </p>
  )
}
