import { db } from "./db"

/** The names, out of `theirs`, the viewer has picked too. */
export async function sharedInterestNames(viewerId: string, theirs: { category: { id: string; name: string } }[]): Promise<string[]> {
  if (theirs.length === 0) return []
  const mine = await db.user_interests.findMany({
    where: { user_id: viewerId, category_id: { in: theirs.map((t) => t.category.id) } },
    select: { category_id: true },
  })
  const shared = new Set(mine.map((m) => m.category_id))
  return theirs.filter((t) => shared.has(t.category.id)).map((t) => t.category.name)
}
