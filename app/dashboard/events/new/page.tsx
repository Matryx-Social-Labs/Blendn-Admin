import { redirect } from "next/navigation"
import { EventEditor } from "@/components/event-editor"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { canCreateEvents } from "@/lib/rbac"

export const dynamic = "force-dynamic"

export default async function NewEventPage() {
  const session = await getAuth()
  /*
   * An allowlist, via `lib/rbac.ts`, not a denylist on `attendee`.
   *
   * `venue_owner` belongs here: `eventPermissions` grants them both buckets on
   * an event their own org runs, and a venue owner hosting their own night is a
   * case the model supports and the UI used to forbid.
   *
   * The shape is the point. This read `role === "attendee"` — so the moment
   * `sponsor` joined the enum, every sponsor could publish events, with no
   * error and nothing in a log. `canCreateEvents` names who may, and
   * `__tests__/authz-scoping-boundary.test.ts` fails the build on a new
   * denylist.
   */
  if (!session?.user || !canCreateEvents(session.user.role)) {
    redirect("/dashboard/events")
  }

  /*
   * With the parent, because the picker groups by it.
   *
   * The taxonomy is two levels — `Sports` with children like `IPL screening`,
   * separated deliberately because they draw different crowds — and the form
   * rendered all 89 as one alphabetised wall of checkboxes, so `Sports` and
   * `IPL screening` sat as peers ~1000px apart. `/dashboard/categories` has
   * grouped them by parent all along.
   */
  const categories = await db.categories.findMany({
    select: {
      id: true,
      name: true,
      parent_id: true,
      parent: { select: { name: true } },
    },
    orderBy: [{ parent: { name: "asc" } }, { name: "asc" }],
  })

  /*
   * Active only, in the vocabulary's own order. A retired amenity still
   * resolves on events that already reference it — the foreign key is
   * `Restrict` — but it is no longer offered for new ones.
   */
  const amenities = await db.amenities.findMany({
    where: { is_active: true },
    select: { id: true, name: true, subtitle: true },
    orderBy: { sort_order: "asc" },
  })

  return (
    <EventEditor
      categories={categories}
      amenities={amenities}
      canFeature={session.user.role === "app_admin"}
    />
  )
}
