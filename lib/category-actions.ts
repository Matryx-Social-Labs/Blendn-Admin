"use server"

import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"

/**
 * Managing the category taxonomy.
 *
 * Categories were seeded by `scripts/seed-categories.ts` and nothing else. An
 * admin could not rename a typo, retire a dead category, or merge the two that
 * always end up meaning the same thing.
 *
 * The taxonomy is two levels — a parent like Sports with children like IPL
 * Streaming — and every operation here has to keep it two levels. A category
 * with a parent cannot itself become a parent, or the mobile client's filter
 * (which expands one level) silently stops matching the grandchildren.
 */

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")
  return session.user
}

export interface CategoryRow {
  id: string
  name: string
  slug: string
  parentId: string | null
  parentName: string | null
  eventCount: number
  /**
   * How many people have declared this interest.
   *
   * Surfaced because merging repoints these, and an admin choosing what to
   * retire was previously shown the event count alone — so the number that
   * matters most to matching was the one number they could not see.
   */
  interestCount: number
}

export async function getCategories(): Promise<CategoryRow[]> {
  await requireAdmin()

  const rows = await db.categories.findMany({
    orderBy: [{ parent_id: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      parent_id: true,
      parent: { select: { name: true } },
      _count: { select: { events: true, user_interests: true } },
    },
  })

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    parentId: r.parent_id,
    parentName: r.parent?.name ?? null,
    // The number that makes a dead category visible. Without it, retiring one
    // is a guess about whether anything is using it.
    eventCount: r._count.events,
    interestCount: r._count.user_interests,
  }))
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const admin = await requireAdmin()
  const trimmed = name.trim()
  if (trimmed.length < 2) throw new Error("Name is too short.")

  const before = await db.categories.findUniqueOrThrow({
    where: { id },
    select: { name: true },
  })

  // The slug is deliberately NOT regenerated. It is what the mobile client
  // filters on and what every shared link contains; renaming "Live Music" to
  // "Live music" must not break every existing deep link.
  await db.categories.update({ where: { id }, data: { name: trimmed } })

  auditLog({
    userId: admin.id,
    action: "category.renamed",
    resource: "category",
    resourceId: id,
    details: { from: before.name, to: trimmed },
  })
  revalidatePath("/dashboard/categories")
}

/**
 * Merge one category into another, reassigning its events.
 *
 * Deleting a category with events attached would silently drop those events out
 * of every category filter, so a merge is the only safe way to retire one.
 */
export async function mergeCategory(
  fromId: string,
  intoId: string
): Promise<{ events: number; interests: number }> {
  const admin = await requireAdmin()
  if (fromId === intoId) throw new Error("Pick two different categories.")

  const [from, into] = await Promise.all([
    db.categories.findUniqueOrThrow({
      where: { id: fromId },
      select: { name: true, _count: { select: { children: true } } },
    }),
    db.categories.findUniqueOrThrow({ where: { id: intoId }, select: { name: true, parent_id: true } }),
  ])

  if (from._count.children > 0) {
    throw new Error("Move or merge its sub-categories first.")
  }

  const moved = await db.$transaction(async (tx) => {
    const links = await tx.event_categories.findMany({
      where: { category_id: fromId },
      select: { event_id: true, primary: true },
    })

    // An event already in the target must not get a duplicate row — the table
    // is keyed on (event_id, category_id), so the insert would throw and take
    // the whole merge with it.
    const existing = new Set(
      (
        await tx.event_categories.findMany({
          where: { category_id: intoId, event_id: { in: links.map((l) => l.event_id) } },
          select: { event_id: true },
        })
      ).map((e) => e.event_id)
    )

    const toCreate = links.filter((l) => !existing.has(l.event_id))
    if (toCreate.length > 0) {
      await tx.event_categories.createMany({
        data: toCreate.map((l) => ({
          event_id: l.event_id,
          category_id: intoId,
          // Primary carries over: an event whose primary category was merged
          // away should still have one.
          primary: l.primary,
        })),
      })
    }

    /*
     * Repoint the people, not just the events.
     *
     * `user_interests.category` is `onDelete: Cascade`, so the delete below
     * used to destroy every user's interest in the merged-away category —
     * silently, with no warning and no undo. `lib/matching.ts` ranks on exactly
     * that table, so one admin click quietly degraded matching for everybody
     * who had picked it, and the only visible effect was worse match cards
     * weeks later.
     *
     * Same duplicate handling as the event links above, and for the same
     * reason: `@@unique([user_id, category_id])` means a user who already holds
     * the target would collide and take the whole merge down with them.
     */
    const interests = await tx.user_interests.findMany({
      where: { category_id: fromId },
      select: { user_id: true },
    })

    const alreadyHeld = new Set(
      (
        await tx.user_interests.findMany({
          where: { category_id: intoId, user_id: { in: interests.map((i) => i.user_id) } },
          select: { user_id: true },
        })
      ).map((i) => i.user_id)
    )

    const interestsToCreate = interests.filter((i) => !alreadyHeld.has(i.user_id))
    if (interestsToCreate.length > 0) {
      await tx.user_interests.createMany({
        data: interestsToCreate.map((i) => ({ user_id: i.user_id, category_id: intoId })),
      })
    }

    await tx.event_categories.deleteMany({ where: { category_id: fromId } })
    /*
     * Explicit, before the category goes. The cascade would remove these rows
     * anyway — the point is that by now they have been copied to the target, so
     * what the cascade would have destroyed no longer exists only here.
     */
    await tx.user_interests.deleteMany({ where: { category_id: fromId } })
    await tx.categories.delete({ where: { id: fromId } })

    return { events: links.length, interests: interests.length }
  })

  auditLog({
    userId: admin.id,
    action: "category.merged",
    resource: "category",
    resourceId: fromId,
    details: {
      from: from.name,
      into: into.name,
      eventsMoved: moved.events,
      // Recorded because this is the number that used to go to zero.
      interestsMoved: moved.interests,
    },
  })
  revalidatePath("/dashboard/categories")
  return moved
}

export async function createCategory(name: string, parentId: string | null): Promise<void> {
  const admin = await requireAdmin()
  const trimmed = name.trim()
  if (trimmed.length < 2) throw new Error("Name is too short.")

  if (parentId) {
    const parent = await db.categories.findUniqueOrThrow({
      where: { id: parentId },
      select: { parent_id: true },
    })
    // Two levels, hard. The mobile filter expands parent → children by one
    // level; a third level would stop matching and nobody would notice until a
    // host asked why their event was invisible.
    if (parent.parent_id) throw new Error("The taxonomy is two levels — pick a top-level parent.")
  }

  /*
   * Slug generation matches scripts/seed-categories.ts exactly, including
   * dropping `&` rather than expanding it to "and". Production slugs were
   * generated by that script — `arts-culture`, not `arts-and-culture` — and a
   * second rule here would create a category the mobile client cannot filter.
   */
  const slug = trimmed
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  const clash = await db.categories.findUnique({ where: { slug }, select: { id: true } })
  if (clash) throw new Error("A category with that slug already exists.")

  const created = await db.categories.create({
    data: { name: trimmed, slug, parent_id: parentId },
    select: { id: true },
  })

  auditLog({
    userId: admin.id,
    action: "category.created",
    resource: "category",
    resourceId: created.id,
    details: { name: trimmed, slug, parentId },
  })
  revalidatePath("/dashboard/categories")
}
