import slugify from "slugify"

import { db } from "./db"

/**
 * A slug for an event that is not already taken.
 *
 * `events.slug` is `@unique`, and both write paths wrote `slugify(title)`
 * straight into it. Two events called "Summer Sessions" — which is what a
 * recurring night is called every month — put an unhandled Prisma P2002 in
 * front of the organiser: the form reports an internal error and loses the
 * draft, for a title collision the product should simply absorb.
 *
 * `excludeEventId` is the rename case: an event editing its own title back to
 * what it already is must not collide with itself and drift to `-2`.
 *
 * Soft-deleted events are deliberately *not* excluded. `deleted_at` does not
 * release the unique constraint, so a slug held by a deleted row is still
 * unavailable to a new one.
 *
 * One prefix query rather than a probe per candidate — the unique index makes
 * `startsWith` a range scan, and the alternative is N round trips to discover
 * a number we can count to locally.
 *
 * The residual window is two identical titles created in the same instant:
 * both read the same set and pick the same suffix, and the second write hits
 * the constraint. That is the constraint doing its job, and it is a far
 * narrower failure than the one it replaces.
 *
 * Pinned by __tests__/event-slug.test.ts.
 */
export async function uniqueEventSlug(title: string, excludeEventId?: string): Promise<string> {
  // A title of pure emoji slugifies to the empty string, and an empty slug is
  // a URL that resolves to the events index rather than to the event.
  const base = slugify(title, { lower: true, strict: true }) || "event"

  const rows = await db.events.findMany({
    where: {
      slug: { startsWith: base },
      ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
    },
    select: { slug: true },
  })
  const taken = new Set(rows.map((r) => r.slug))

  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
