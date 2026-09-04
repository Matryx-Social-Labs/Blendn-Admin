import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"
import { getAmenities } from "@/lib/amenity-actions"

import { AmenityManager } from "./manager"

export const dynamic = "force-dynamic"

/**
 * The amenity vocabulary.
 *
 * Fourteen rows were seeded inside a migration and nothing wrote the table
 * again. `is_active` is a fully designed retirement mechanism — a `Restrict`
 * foreign key, a tick-through on the event form, an index — that could only be
 * reached with a manual `UPDATE` against production.
 */
export default async function AmenitiesPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  return <AmenityManager amenities={await getAmenities()} />
}
