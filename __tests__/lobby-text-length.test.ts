import { z } from "zod"

import { BOARD } from "@/lib/constants"
import { clip } from "@/lib/push-notifications"
import { characters } from "@/lib/utils"

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
