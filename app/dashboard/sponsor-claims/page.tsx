import { redirect } from "next/navigation"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/sponsor-claims")

/**
 * Moved into the shared claim queue.
 *
 * A redirect rather than a deletion, for the reason the venue queue's redirect
 * gives: this URL is in browser histories and possibly somebody's bookmarks,
 * and an admin finding the queue has vanished is a worse outcome than one extra
 * file.
 */
export default function MovedSponsorClaimsPage() {
  redirect("/dashboard/claims/brands")
}
