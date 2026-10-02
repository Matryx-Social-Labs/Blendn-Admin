/**
 * An event's public address: what the QR & link tab encodes (step 15).
 *
 * `www`, not the apex, for the reason `INVITE_LINK_BASE` gives: `blendn.app`
 * answers with a 307 to `www`, and Apple and Google both refuse an association
 * file served behind a redirect, so an apex link could never open the app.
 *
 * `/event/<id>` because that is the app's own route (`app/event/[id].tsx` in
 * the client) and the id is the key every event surface takes — the mobile API
 * refuses anything else. Never the slug: it is rewritten when the title
 * changes, and a printed code must outlive a rename. Nothing but the id goes
 * in: no token, no viewer, nothing a scanner could replay as somebody.
 */
export const EVENT_LINK_BASE = "https://www.blendn.app/event/"

export function eventShareUrl(eventId: string): string {
  return EVENT_LINK_BASE + encodeURIComponent(eventId)
}

/**
 * Whether the address opens anything yet.
 *
 * It does not, on 2026-10-02: www.blendn.app's association file lists only
 * `/f/*` and the app's https intent filter only `/f/`, so a phone with the app
 * opens the browser, and the site has no `/event/` page, so that browser shows
 * "not found". The tab says so while this is false, and still hands over the
 * code: the address is permanent, so a code printed today starts working the
 * day the landing page and the app learn it (SCRUM-537). Flip this then.
 */
export const EVENT_LINKS_LIVE = false
