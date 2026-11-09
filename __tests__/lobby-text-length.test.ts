import { readFileSync } from "fs"
import { join } from "path"
import { z } from "zod"

import { fileBoardReport } from "@/lib/board-access"
import { BOARD } from "@/lib/constants"
import { db } from "@/lib/db"
import { clip } from "@/lib/push-notifications"
import { characters, clipCharacters } from "@/lib/utils"

jest.mock("@/lib/db", () => ({ db: {} }))

const HOST_POST_MAX = BOARD.MAX_HOST_POST_LENGTH

/*
 * Lobby text is counted as Postgres's `char_length` counts it: code points
 * (SCRUM-1026). The CHECKs `board_host_posts_body_length` (1–500) and
 * `board_posts_photo_alt_fits` (200) count that way, the dashboard's counter
 * counts with `characters`, and the routes' `.max()` does too: zod's
 * `$ZodCheckMaxLength` measures strings in code points in every version
 * package.json allows (^4.6.5; checked 4.6.5–4.6.7). The integration tests
 * drive each route with emoji; this pins the three pieces they rest on, so a
 * zod that went back to UTF-16 units fails here first.
 */

const party = "🎉"

describe("zod's .max() on a string, as every Lobby route uses it", () => {
  const note = z.string().trim().min(1).max(HOST_POST_MAX)

  it("takes 500 emoji (500 code points, 1,000 UTF-16 units) and refuses the 501st", () => {
    expect(party.repeat(HOST_POST_MAX).length).toBe(1000)
    expect(note.safeParse(party.repeat(HOST_POST_MAX)).success).toBe(true)
    expect(note.safeParse(party.repeat(HOST_POST_MAX + 1)).success).toBe(false)
  })
})

describe("characters", () => {
  it("counts code points, as char_length does: an emoji is one, Devanagari its code points, a flag two", () => {
    expect(characters(party)).toBe(1)
    expect(characters(party.repeat(HOST_POST_MAX))).toBe(HOST_POST_MAX)
    expect(characters("वेंकटलक्ष्मी")).toBe(12)
    expect(characters("🇮🇳")).toBe(2)
  })
})

describe("clip, the push preview", () => {
  it("never cuts an emoji in half (a lone surrogate draws as �)", () => {
    const clipped = clip(party.repeat(200), 120)
    expect(characters(clipped)).toBe(120)
    expect(clipped.endsWith(`${party}...`)).toBe(true)
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it("leaves text that fits alone", () => {
    expect(clip(party.repeat(120), 120)).toBe(party.repeat(120))
  })
})

/*
 * SCRUM-1033: a post is counted in code points everywhere — the route's zod
 * `.max()`, the client's counter (`codePoints`, 280 inside the server's 500)
 * and Postgres's `char_length` — and every cut of a post's text (the push
 * preview, the report's excerpt, the room's name, the dashboard's quote) is
 * `clipCharacters`: at most N code points, and only ever between graphemes,
 * so a family, a flag or a skin tone is never left half drawn.
 */
const family = "👨‍👩‍👧" // five code points, one grapheme
const flag = "🇮🇳" // two code points, one grapheme
const CLIENT_POST_MAX = 280 // the app's counter (blendn lib/lobby.ts LOBBY_POST_MAX)

describe("a post of 280 emoji", () => {
  const post = z.string().trim().min(1).max(BOARD.MAX_POST_LENGTH)

  it("is taken by the counter and the route alike when each emoji is one code point", () => {
    const body = party.repeat(CLIENT_POST_MAX)
    expect(characters(body)).toBe(CLIENT_POST_MAX)
    expect(post.safeParse(body).success).toBe(true)
  })

  it("is refused by the counter and the route alike when each emoji is several", () => {
    for (const emoji of [family, flag]) {
      const body = emoji.repeat(CLIENT_POST_MAX)
      expect(characters(body)).toBeGreaterThan(BOARD.MAX_POST_LENGTH)
      expect(post.safeParse(body).success).toBe(false)
    }
  })
})

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("clipCharacters", () => {
  it("leaves text that fits alone", () => {
    expect(clipCharacters(party.repeat(5), 5)).toBe(party.repeat(5))
  })

  it("cuts at most max code points, and only between graphemes", () => {
    expect(clipCharacters(family.repeat(3), 7)).toBe(family)
    expect(clipCharacters(flag.repeat(3), 5)).toBe(flag.repeat(2))
    expect(clipCharacters(`a${party.repeat(10)}`, 4)).toBe(`a${party.repeat(3)}`)
  })
})

describe("clip, on emoji of several code points", () => {
  it("never leaves a family or a flag half drawn", () => {
    for (const emoji of [family, flag]) {
      const clipped = clip(emoji.repeat(100), 120)
      expect(characters(clipped)).toBeLessThanOrEqual(120)
      expect(clipped.endsWith(`${emoji}...`)).toBe(true)
      expect(clipped.slice(0, -3)).toBe(emoji.repeat(clipped.slice(0, -3).length / emoji.length))
    }
  })
})

describe("the report's excerpt", () => {
  it("is cut between graphemes, never inside a surrogate pair", async () => {
    const created: { excerpt?: string }[] = []
    const tx = {
      message_reports: { create: jest.fn(async ({ data }: { data: { excerpt?: string } }) => created.push(data)) },
      board_posts: { updateMany: jest.fn() },
    }
    ;(db as unknown as { $transaction: unknown }).$transaction = (fn: (t: typeof tx) => Promise<void>) => fn(tx)
    await fileBoardReport({ reporterId: "r", type: "board_post", id: "p", reason: "spam", excerpt: `a${party.repeat(600)}` })
    const excerpt = created[0].excerpt ?? ""
    expect(excerpt).not.toMatch(loneSurrogate)
    expect(characters(excerpt)).toBe(500)
  })
})

describe("every cut of Lobby text", () => {
  it("goes through clipCharacters, not String#slice (UTF-16 units)", () => {
    for (const file of ["lib/board-access.ts", "app/dashboard/moderation/reports/actions.ts"]) {
      const source = readFileSync(join(__dirname, "..", file), "utf8")
      expect({ file, slices: source.match(/\.slice\(0, *[\w.]+\)/g) ?? [] }).toEqual({ file, slices: [] })
    }
  })
})
