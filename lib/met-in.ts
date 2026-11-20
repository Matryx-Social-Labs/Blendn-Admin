export const metInSelect = { kind: true, title: true, status: true, deleted_at: true, venue: { select: { name: true } } } as const

/**
 * Where the two met, as the recipient reads it: the room's kind and the name a page gives it — the event's title,
 * or a venue day's venue (never its stored "Venue day · …" title). Nothing that identifies the room or the sender
 * in it: no event id, no handle, no pseudonym. Null for no room, and for one that is gone or hidden (a draft is a
 * suspended or unpublished event).
 */
export function metInFor(
  event: { kind: "event" | "venue_day"; title: string; status: string; deleted_at: Date | null; venue: { name: string } | null } | null
): { kind: "event" | "venue_day"; name: string } | null {
  if (!event || event.deleted_at || event.status === "draft") return null
  const name = event.kind === "venue_day" ? event.venue?.name : event.title
  return name ? { kind: event.kind, name } : null
}
