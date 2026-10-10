import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

import { CUISINE_LOVES, HOME_STATES, IPL_TEAMS, LANGUAGES, SIGNS } from "@/lib/about-you"
import { THIS_OR_THAT } from "@/lib/this-or-that"

/**
 * Never build (plan v2 §8.4, the owner's ruling of 2026-10-01): no caste,
 * community, religion, gotra, surname, kundli or guna score, skin tone, and no
 * veg / non-veg — in India a documented caste proxy. Not as a column, a field
 * the API takes or returns, a filter or a rank. MV-G01.
 *
 * The guard reads identifiers, not prose: a model's fields and enum values in
 * the schema, every object key and identifier-shaped string literal in lib/
 * and app/ (comments stripped — the comments that explain the ruling name the
 * words), and the matching vocabulary's own labels. The client repo carries
 * the same guard over its own source (`__tests__/neverBuildFields.test.ts`).
 */

/** Whole tokens of an identifier, split on `_`, `-` and camel case. */
const tokens = (id: string): string[] =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const NEVER = new Set([
  "kundli",
  "kundali",
  "guna",
  "manglik",
  "nakshatra",
  "varna",
  "caste",
  "jati",
  "gotra",
  "religion",
  "religious",
  "surname",
  "skin",
  "veg",
  "vegetarian",
  "nonveg",
  "eggetarian",
  "diet",
  "dietary",
])
/** Identifiers only: "community" is a word in strings ("community guidelines"), never a field. */
const NEVER_AS_FIELD = new Set([...NEVER, "community"])

/**
 * Kinds of PLACE, not attributes of a person: a venue can be a temple or a
 * community hall (`venue_type`, lib/venue-types.ts). Nothing here describes
 * who somebody is. Each entry is a decision; keep the list short.
 */
const PLACES_NOT_PEOPLE = new Set(["religious_venue", "community_hall", "community_centre"])

const offending = (ids: Iterable<string>, banned: Set<string>) =>
  [...new Set(ids)].filter((id) => !PLACES_NOT_PEOPLE.has(id) && tokens(id).some((t) => banned.has(t)))

const ROOT = join(__dirname, "..")

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__") sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "")

/** Field names and enum values in schema.prisma. */
function schemaIdentifiers(schema: string): string[] {
  const ids: string[] = []
  for (const block of schema.matchAll(/^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    ids.push(block[2])
    for (const line of block[3].split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("//") || t.startsWith("@@")) continue
      ids.push(t.split(/\s+/)[0])
    }
  }
  return ids
}

/** Object keys and identifier-shaped string literals in source. */
function sourceIdentifiers(src: string): { keys: string[]; literals: string[] } {
  const code = strip(src)
  return {
    keys: [...code.matchAll(/([A-Za-z_$][\w$]*)\??\s*:/g)].map((m) => m[1]),
    literals: [...code.matchAll(/["'`]([A-Za-z_][\w-]*)["'`]/g)].map((m) => m[1]),
  }
}

describe("never build: caste, kundli, veg and their kin (MV-G01)", () => {
  it("the guard sees what it guards (control)", () => {
    expect(offending(schemaIdentifiers("model profiles {\n  id String\n  diet String?\n}\n"), NEVER_AS_FIELD)).toEqual(["diet"])
    expect(offending(sourceIdentifiers('z.object({ nonVeg: z.boolean() })').keys, NEVER_AS_FIELD)).toEqual(["nonVeg"])
    expect(offending(sourceIdentifiers('z.enum(["veg", "non_veg"])').literals, NEVER)).toEqual(["veg", "non_veg"])
    // Prose in a comment is not a field.
    expect(sourceIdentifiers("// never a caste field\nconst a = 1").keys).toEqual([])
  })

  it("no column or enum value in the schema", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8")
    expect(schemaIdentifiers(schema).length).toBeGreaterThan(500)
    expect(offending(schemaIdentifiers(schema), NEVER_AS_FIELD)).toEqual([])
  })

  it("no field the API takes or returns, in lib/ or app/", () => {
    const files = [...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app"))]
    expect(files.length).toBeGreaterThan(300)
    const found: string[] = []
    for (const file of files) {
      const { keys, literals } = sourceIdentifiers(readFileSync(file, "utf8"))
      for (const id of [...offending(keys, NEVER_AS_FIELD), ...offending(literals, NEVER)]) {
        found.push(`${relative(ROOT, file)} -> ${id}`)
      }
    }
    expect(found).toEqual([])
  })

  it("nothing in the matching vocabulary is a diet, a faith or a caste proxy", () => {
    const words = [
      ...LANGUAGES.flatMap((o) => [o.slug, o.label]),
      ...HOME_STATES.flatMap((o) => [o.slug, o.label]),
      ...SIGNS.flatMap((s) => [s.slug, s.western, s.rashi]),
      ...THIS_OR_THAT.flatMap((q) => [q.slug, q.a.label, q.a.phrase, q.b.label, q.b.phrase]),
      ...IPL_TEAMS.flatMap((t) => [t.code, t.name]),
      ...CUISINE_LOVES,
    ]
    // Meat, alcohol and worship on either side of a this-or-that, or as a
    // "cuisine love", is the veg / non-veg question asked another way.
    const proxy = new Set([
      ...NEVER,
      ...["meat", "chicken", "mutton", "beef", "pork", "fish", "egg", "eggs", "alcohol", "beer", "wine", "whisky", "drinks"],
      ...["temple", "church", "mosque", "gurdwara", "puja", "namaz", "fast", "fasting"],
    ])
    expect(words.filter((w) => tokens(w).some((t) => proxy.has(t)))).toEqual([])
  })
})
