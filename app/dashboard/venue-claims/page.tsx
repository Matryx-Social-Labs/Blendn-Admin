import { redirect } from "next/navigation"

/**
 * Moved into the shared claim queue.
 *
 * A redirect rather than a deletion: this URL is in browser histories and
 * possibly in somebody's bookmarks, and an admin discovering the queue has
 * vanished is a worse outcome than one extra file. Cheap to keep.
 */
export default function MovedVenueClaimsPage() {
  redirect("/dashboard/claims/venues")
}
