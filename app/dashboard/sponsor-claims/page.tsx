import { redirect } from "next/navigation"

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
