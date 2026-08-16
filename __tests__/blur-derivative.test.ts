import { readFileSync } from "fs"
import { join } from "path"

/**
 * "Pseudonyms + blurred photos" — the matched-but-unrevealed state the diagram
 * on `private_conversations` describes.
 *
 * The whole security property is that the blur is a **stored derivative**, not a
 * filter over a real URL. If the real URL ever reaches a viewer who has not
 * earned it, nothing else here matters: a proxy, a cache dump or devtools undoes
 * an app-side blur in one step, and this repo shipped exactly that bug before —
 * `MatchScreen.tsx` still carries the comment "the anonymity was one tap deep".
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")
const ROUTE = () => read("app", "api", "mobile", "profiles", "[userId]", "route.ts")

describe("the unrevealed branch sends the derivative and nothing else", () => {
  it("serves blur_photo only when NOT identified", () => {
    const route = ROUTE()
    const block = route.slice(route.indexOf("...(identified"))
    const branches = block.slice(0, block.indexOf("...(identified && p.show_orientation"))
    const [ifIdentified, elseBranch] = branches.split(": {")
    expect(ifIdentified).not.toContain("blur_photo")
    expect(elseBranch).toContain("blurPhoto: p.blur_photo")
  })

  it("never puts the real photos in the same branch", () => {
    /*
     * The point of the derivative is that the original is absent. Sending both
     * would make the blur decorative and the anonymity one tap deep again.
     */
    const route = ROUTE()
    const block = route.slice(route.indexOf("blurPhoto: p.blur_photo"))
    expect(block.slice(0, block.indexOf("}"))).not.toContain("photos: p.photos")
  })
})

describe("a face does not survive account deletion, even at 40 pixels", () => {
  it("scrubs blur_photo with the photos it came from", () => {
    // A surviving blur is still a surviving photograph of a person who asked to
    // be gone.
    const account = read("app", "api", "mobile", "account", "route.ts")
    const block = account.slice(account.indexOf("photos: []"))
    expect(block.slice(0, block.indexOf("goals:"))).toContain("blur_photo: null")
  })
})

describe("the column says what it is for", () => {
  it("is nullable, so removing your last photo can clear it", () => {
    expect(read("prisma", "schema.prisma")).toContain("blur_photo    String?")
  })

  it("is documented in the OpenAPI schema", () => {
    // `docs/API.md` and the spec are expected to match real behaviour, and a
    // client that does not know this field exists will draw a grey hole.
    expect(read("lib", "openapi", "schemas", "profile.ts")).toContain("blur_photo: z")
  })

  it("is accepted on update, and nullable there too", () => {
    expect(read("lib", "validations", "profile.ts")).toContain(
      "blur_photo: z.string().url().nullish()"
    )
  })

  it("ships a migration that adds nothing else", () => {
    /*
     * Null for every existing row: nobody has generated a derivative yet, and an
     * unrevealed profile without one falls back to the generated mark rather
     * than to a real photograph.
     */
    const sql = read("prisma", "migrations", "20260816120000_profile_blur_photo", "migration.sql")
    expect(sql).toContain('ALTER TABLE "profiles" ADD COLUMN "blur_photo" TEXT')
    expect(sql).not.toContain("NOT NULL")
  })
})
