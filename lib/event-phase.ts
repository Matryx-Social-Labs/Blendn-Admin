export type LivePhase = "pre" | "live" | "post"

/**
 * Which phase the event is in, from its own schedule.
 *
 * Extracted out of `components/dashboard/live-tab.tsx`, which is a client
 * component — a server component importing it dragged the whole live view and
 * its socket hook across the boundary for one date comparison.
 */
export function livePhaseFor(startAt: string, endAt: string, now = new Date()): LivePhase {
  const start = new Date(startAt)
  const end = new Date(endAt)
  if (now < start) return "pre"
  if (now > end) return "post"
  return "live"
}

/**
 * The four states the Overview is designed around.
 *
 * `LivePhase` answers "where are we in the schedule". This answers "what is the
 * organiser's question right now", which is not the same: an unpublished event
 * whose start time has passed is still a draft, and asking "will it fill?" of
 * something nobody can see would be nonsense.
 *
 *   draft     — what is stopping this from being published?
 *   upcoming  — will it fill?
 *   live      — is it going okay right now?
 *   over      — was it good, and what do I do differently?
 *
 * `cancelled` collapses into `over`. A cancelled event has no future to pace
 * towards, and its RSVPs are still worth seeing.
 */
export type EventState = "draft" | "upcoming" | "live" | "over"

export function eventStateFor(
  event: { status: string; start_time: Date; end_time: Date },
  now = new Date()
): EventState {
  if (event.status === "draft") return "draft"
  if (event.status === "cancelled" || event.status === "completed") return "over"

  const phase = livePhaseFor(
    event.start_time.toISOString(),
    event.end_time.toISOString(),
    now
  )
  return phase === "pre" ? "upcoming" : phase === "live" ? "live" : "over"
}

/** What the screen is asking, per state. Used as the Overview's own subtitle. */
export const STATE_QUESTION: Record<EventState, string> = {
  draft: "What is stopping this from being published?",
  upcoming: "Will it fill?",
  live: "Is it going okay right now?",
  over: "Was it good, and what would you do differently?",
}

export interface PublishBlocker {
  key: string
  label: string
  /** Blocking, or merely worth fixing. Only blockers stop a publish. */
  blocking: boolean
  hint: string
}

/**
 * Why a draft cannot go out yet.
 *
 * The check-in coordinates are a hard blocker rather than a warning: the
 * check-in route refuses an event with no coordinates, so publishing one
 * produces an event nobody can attend — which looks like the app being broken
 * rather than the event being misconfigured.
 */
export function publishBlockers(event: {
  title: string
  description: string | null
  start_time: Date
  end_time: Date
  latitude: number | null
  longitude: number | null
  venue_name: string | null
  venue_id: string | null
  max_capacity: number | null
  cover_image_url: string | null
  categoryCount: number
}): PublishBlocker[] {
  const out: PublishBlocker[] = []

  if (event.title.trim().length < 3) {
    out.push({
      key: "title",
      label: "Give it a title",
      blocking: true,
      hint: "Three characters or more.",
    })
  }

  if ((event.description ?? "").trim().length < 10) {
    out.push({
      key: "description",
      label: "Describe it",
      blocking: true,
      hint: "This is what someone reads before deciding to come.",
    })
  }

  if (event.end_time <= event.start_time) {
    out.push({
      key: "schedule",
      label: "Ends before it starts",
      blocking: true,
      hint: "Check the end time and the timezone.",
    })
  }

  if (event.latitude === null || event.longitude === null) {
    out.push({
      key: "location",
      label: "Place it on the map",
      blocking: true,
      hint: "Check-in is GPS-gated. Without coordinates nobody can check in, and the app looks broken rather than the event looking unfinished.",
    })
  }

  if (!event.venue_name && !event.venue_id) {
    out.push({
      key: "venue",
      label: "Name the venue",
      blocking: true,
      hint: "Pick a listed venue or type the name.",
    })
  }

  if (event.categoryCount === 0) {
    out.push({
      key: "categories",
      label: "Pick at least one category",
      blocking: false,
      hint: "Categories are how people filter the app. Without one this is much harder to find.",
    })
  }

  if (!event.cover_image_url) {
    out.push({
      key: "cover",
      label: "Add a cover image",
      blocking: false,
      hint: "Events without one get noticeably fewer RSVPs.",
    })
  }

  if (event.max_capacity === null) {
    out.push({
      key: "capacity",
      label: "Set a capacity",
      blocking: false,
      hint: "Optional, but without it there is no fill percentage and no overbooking guard.",
    })
  }

  return out
}
