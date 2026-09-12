"use server"

import { revalidatePath } from "next/cache"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"

/**
 * Managing the amenity vocabulary.
 *
 * Fourteen rows were seeded **inside a migration** and nothing has written the
 * table since. `is_active` is a fully designed retirement mechanism — a
 * `Restrict` foreign key so a used amenity cannot vanish, a tick-through on the
 * event form, an index on `(is_active, sort_order)` — and it was unreachable
 * without a manual `UPDATE` against production.
 *
 * `categories` outgrew exactly the same "seeded by a script, no admin UI"
 * comment and got a manager. Amenities did not, and this is that.
 *
 * ## Retire, never delete
 *
 * `event_amenities` is `onDelete: Restrict`, and that is the right constraint:
 * deleting an amenity would rewrite what past events said they offered. So the
 * only removal here is `is_active = false` — it stops being offered for new
 * events and still resolves on the ones that already reference it.
 */

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  return session.user
}

export interface AmenityRow {
  id: string
  name: string
  slug: string
  subtitle: string | null
  icon: string | null
  sortOrder: number
  isActive: boolean
  /**
   * How many events already offer this.
   *
   * Shown because retiring one is the decision this screen exists for, and the
   * category manager learned the same lesson the hard way: an admin choosing
   * what to retire was shown the event count and not the interest count, so the
   * number that mattered most was the one they could not see. Here the number
   * that matters is how much history a retirement would quietly contradict.
   */
  eventCount: number
}

/**
 * Every amenity, retired ones included.
 *
 * The mobile route filters to `is_active` because a picker should not offer a
 * withdrawn option. This is the admin view, where the retired ones are the
 * whole point — you cannot bring one back if you cannot see it.
 */
export async function getAmenities(): Promise<AmenityRow[]> {
  await requireAdmin()

  const rows = await db.amenities.findMany({
    orderBy: [{ is_active: "desc" }, { sort_order: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      subtitle: true,
      icon: true,
      sort_order: true,
      is_active: true,
      _count: { select: { events: true } },
    },
  })

  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    subtitle: a.subtitle,
    icon: a.icon,
    sortOrder: a.sort_order,
    isActive: a.is_active,
    eventCount: a._count.events,
  }))
}

/**
 * A slug that does not collide.
 *
 * `slug` is `@unique` and the client maps it to a glyph, so it is an identifier
 * rather than a label — renaming an amenity must not change it, and creating
 * two called "Open Bar" must not throw a raw P2002 in an admin's face. Same
 * hazard `uniqueEventSlug` exists for, same shape of answer.
 */
async function freeSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "amenity"

  const taken = new Set(
    (
      await db.amenities.findMany({
        where: { slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((r) => r.slug)
  )

  if (!taken.has(base)) return base
  for (let n = 2; n < 200; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error("Could not find a free slug for that name")
}

export async function createAmenity(input: {
  name: string
  subtitle?: string | null
  icon?: string | null
  sortOrder?: number
}): Promise<void> {
  const user = await requireAdmin()
  const name = input.name.trim()
  if (name.length < 2) throw new Error("Name is required")

  /*
   * Same name, refused; same slug from a different name, suffixed. The suffix
   * exists so "Open Bar" and "Open-bar!" do not throw a P2002 — but it also
   * let a second "Cloakroom" in as `cloakroom-2`, and the organiser's picker
   * then offered Cloakroom twice. Found by adding one that already existed.
   */
  const same = await db.amenities.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { is_active: true },
  })
  if (same) {
    throw new Error(
      same.is_active
        ? `"${name}" already exists — rename that one instead`
        : `"${name}" exists but is retired — restore it instead of adding a second`
    )
  }

  const created = await db.amenities.create({
    data: {
      name,
      slug: await freeSlug(name),
      subtitle: input.subtitle?.trim() || null,
      icon: input.icon?.trim() || null,
      /*
       * Appended, not zero. `sort_order` decides the picker's order and
       * defaults to 0, so every new amenity would otherwise land at the top
       * alongside every other one that was never ordered — and the explicit
       * ordering exists precisely because alphabetical puts "Accessible
       * Entrance" above "Open Bar" on every card in the app.
       */
      sort_order: input.sortOrder ?? (await nextSortOrder()),
    },
    select: { id: true, name: true },
  })

  auditLog({
    userId: user.id,
    action: "amenity.create",
    resource: "amenity",
    resourceId: created.id,
    details: { name: created.name },
  })
  revalidatePath("/dashboard/amenities")
}

async function nextSortOrder(): Promise<number> {
  const last = await db.amenities.aggregate({ _max: { sort_order: true } })
  return (last._max.sort_order ?? 0) + 10
}

export async function updateAmenity(
  id: string,
  input: { name?: string; subtitle?: string | null; icon?: string | null; sortOrder?: number }
): Promise<void> {
  const user = await requireAdmin()

  const existing = await db.amenities.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new Error("Amenity not found")

  const name = input.name?.trim()
  if (name !== undefined && name.length < 2) throw new Error("Name is required")

  await db.amenities.update({
    where: { id },
    data: {
      // Conditional spreads: `strictUndefinedChecks` is on, so passing an
      // explicit `undefined` is an error rather than "leave this alone".
      ...(name !== undefined && { name }),
      ...(input.subtitle !== undefined && { subtitle: input.subtitle?.trim() || null }),
      ...(input.icon !== undefined && { icon: input.icon?.trim() || null }),
      ...(input.sortOrder !== undefined && { sort_order: input.sortOrder }),
      updated_at: new Date(),
    },
  })

  /*
   * The slug is deliberately NOT recomputed on rename. It is the identifier the
   * client maps to a glyph, so changing it would silently drop the icon on
   * every event already offering this amenity — a cosmetic edit with a
   * consequence nobody would connect to it.
   */
  auditLog({
    userId: user.id,
    action: "amenity.update",
    resource: "amenity",
    resourceId: id,
    details: { ...input },
  })
  revalidatePath("/dashboard/amenities")
}

/**
 * Retire, or bring back.
 *
 * The only removal there is. `event_amenities` is `onDelete: Restrict`, so a
 * used amenity cannot be deleted at all — and should not be: deleting one
 * rewrites what past events said they offered.
 */
export async function setAmenityActive(id: string, isActive: boolean): Promise<void> {
  const user = await requireAdmin()

  const existing = await db.amenities.findUnique({
    where: { id },
    select: { id: true, name: true, is_active: true },
  })
  if (!existing) throw new Error("Amenity not found")
  if (existing.is_active === isActive) return

  await db.amenities.update({
    where: { id },
    data: { is_active: isActive, updated_at: new Date() },
  })

  auditLog({
    userId: user.id,
    action: isActive ? "amenity.restore" : "amenity.retire",
    resource: "amenity",
    resourceId: id,
    details: { name: existing.name },
  })
  revalidatePath("/dashboard/amenities")
}
