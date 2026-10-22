import type { user_role } from "@prisma/client"
import { canAccessDashboard } from "@/lib/rbac"

/** The app's own scheme: opens Blend'n on a phone that has it. */
export const APP_DEEP_LINK = "blendn://"

/** The listings, by the ids in docs/IAP-SETUP.md. Shown only once they are public. */
const APP_STORE_URL = "https://apps.apple.com/app/id6757761059"
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.matryxsociallabs.blendn"

export interface AppLinks {
  deepLink: string
  /** Null until `APP_STORE_LISTED=true`: a store link before the listing is public is a dead end. */
  appStoreUrl: string | null
  /** Null until `PLAY_LISTED=true`. */
  playStoreUrl: string | null
}

/** Which surface somebody belongs to: the phone app for an attendee, the dashboard for every other role. */
export type Audience = "attendee" | "dashboard"

export const audienceOf = (role: user_role): Audience => (canAccessDashboard(role) ? "dashboard" : "attendee")

/**
 * Where "Open Blend'n" goes, for an attendee; null for a dashboard role, who
 * signs in on the web (SV15). The flags are the landing page's own names
 * (`betaLinks.ts`), so one switch per store flips both sites.
 */
export function appLinksFor(audience: Audience): AppLinks | null {
  if (audience !== "attendee") return null
  return {
    deepLink: APP_DEEP_LINK,
    appStoreUrl: process.env.APP_STORE_LISTED?.trim() === "true" ? APP_STORE_URL : null,
    playStoreUrl: process.env.PLAY_LISTED?.trim() === "true" ? PLAY_STORE_URL : null,
  }
}
