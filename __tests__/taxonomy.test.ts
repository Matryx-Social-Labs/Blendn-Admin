import { slugify, TAXONOMY } from "../scripts/seed-categories"

/*
 * The category tree, guarded at the one place it can break silently.
 *
 * `seed-categories.ts` upserts **on slug**. So two names that slugify to the
 * same string are not a duplicate-row error — the second upsert *updates the
 * first*, reparenting a live category and taking its events with it. Nothing
 * throws, the script prints its usual counts, and the damage is only visible by
 * reading the table afterwards.
 *
 * That has already happened once: an earlier version expanded "&" to "and",
 * which did not match production's `arts-culture` and `food-drink`, and created
 * two phantom parents. Only the orphan check at the end of the script caught it,
 * and only because somebody read the output.
 *
 * These run in CI, which nobody has to remember to read.
 */

describe("the category taxonomy", () => {
  const parents = Object.keys(TAXONOMY)

  it("has no two parents that slugify the same", () => {
    const slugs = parents.map(slugify)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it("has no two children under one parent that slugify the same", () => {
    for (const [parent, children] of Object.entries(TAXONOMY)) {
      const slugs = children.map((c) => `${slugify(parent)}-${slugify(c)}`)
      expect({ parent, unique: new Set(slugs).size }).toEqual({
        parent,
        unique: slugs.length,
      })
    }
  })

  it("has no child slug colliding with a parent slug", () => {
    /*
     * The collision that would actually hurt. A child slug is
     * `parent-child`, so a parent literally named "Food & Drink Coffee" would
     * produce `food-drink-coffee` and collide with Food & Drink's Coffee —
     * whose upsert would then set `parent_id` on a top-level category and hide
     * a whole branch of the tree.
     */
    const parentSlugs = new Set(parents.map(slugify))
    const childSlugs = Object.entries(TAXONOMY).flatMap(([p, cs]) =>
      cs.map((c) => `${slugify(p)}-${slugify(c)}`)
    )
    expect(childSlugs.filter((s) => parentSlugs.has(s))).toEqual([])
  })

  it("produces slugs the URL and the filter can both carry", () => {
    const all = [...parents.map(slugify), ...Object.entries(TAXONOMY).flatMap(([p, cs]) =>
      cs.map((c) => `${slugify(p)}-${slugify(c)}`)
    )]
    for (const slug of all) {
      // `categorySlug` goes into a query string and into every shared link.
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it("stays two levels deep", () => {
    // `app/api/mobile/events/route.ts` matches a category or its **direct**
    // children. A third level would be silently missed by every parent filter,
    // and the symptom is an underfull list rather than an error.
    for (const children of Object.values(TAXONOMY)) {
      expect(Array.isArray(children)).toBe(true)
      for (const child of children) expect(typeof child).toBe("string")
    }
  })

  it("can express an event whose purpose is meeting people", () => {
    /*
     * Not a shape check — a product one, and the reason this parent exists.
     *
     * This app is for approaching someone at an event without risking
     * rejection. There was no category for an event *whose entire purpose is
     * that*: "Community" is volunteering and hobby groups, "Networking" is
     * professional, and a singles night had to be filed under Nightlife >
     * Parties, indistinguishable from a club night somebody attends with the
     * friends they already have.
     *
     * If this ever gets removed, the most likely search on the platform stops
     * having an answer again.
     */
    expect(TAXONOMY.Social).toBeDefined()
    expect(TAXONOMY.Social).toEqual(expect.arrayContaining(["Singles nights", "Speed dating"]))
  })
})
