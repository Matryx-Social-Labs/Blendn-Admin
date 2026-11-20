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

/** What `lobbyMetInFor` reads of a request's Lobby room: its post, and the post's event as `metInFor` reads one. */
export const metInRoomSelect = {
  board_post: { select: { author_id: true, sub_kind: true, deleted_at: true, event: { select: metInSelect } } },
} as const

/**
 * "Met in the Lobby · Your ride" (Flow 5 C5), as `viewerId` reads it: the night's name (as `metInFor` gives it), what
 * the post is about, and whether it is the reader's own post. Nothing that identifies the room or anybody in it. Null
 * once the post is withdrawn or taken down, or its event is gone or hidden.
 */
export function lobbyMetInFor(
  room: {
    board_post: {
      author_id: string
      sub_kind: "ride" | "spots" | "ticket" | "buddy" | null
      deleted_at: Date | null
      event: Parameters<typeof metInFor>[0]
    } | null
  } | null,
  viewerId: string
): { kind: "board_post"; name: string; subKind: "ride" | "spots" | "ticket" | "buddy" | null; yours: boolean } | null {
  const post = room?.board_post
  if (!post || post.deleted_at) return null
  const night = metInFor(post.event)
  return night ? { kind: "board_post", name: night.name, subKind: post.sub_kind, yours: post.author_id === viewerId } : null
}
