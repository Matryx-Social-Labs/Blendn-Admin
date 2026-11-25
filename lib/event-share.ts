import { publicSiteOrigin } from "./env"

/**
 * An event's public address: what the QR & link tab encodes (step 15).
 *
 * On `publicSiteOrigin()` (www in production, never the apex: `blendn.app`
 * answers with a 307 to `www`, and Apple and Google both refuse an association
 * file served behind a redirect, so an apex link could never open the app).
 *
 * `/event/<id>` because that is the app's own route (`app/event/[id].tsx` in
 * the client) and the id is the key every event surface takes — the mobile API
 * refuses anything else. Never the slug: it is rewritten when the title
 * changes, and a printed code must outlive a rename. Nothing but the id goes
 * in: no token, no viewer, nothing a scanner could replay as somebody.
 */
export function eventShareUrl(eventId: string): string {
  return `${publicSiteOrigin()}/event/${encodeURIComponent(eventId)}`
}

/**
 * Whether Android opens the app straight from the address.
 *
 * Not yet. The Android app opens only the https paths its intent filter lists,
 * and `/event/` is in that filter only from the next store build (client PR
 * #376). Until then Android shows the web page, whose "Open in Blend'n" button
 * opens the event, and the tab says so. Flip this once that build is on Play.
 */
export const EVENT_LINKS_OPEN_ANDROID_APP = false
