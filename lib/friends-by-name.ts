/**
 * `GET /friends?order=name` (Flow 7 1-A): friends A–Z under their letter heads, a page at a time, with every letter's
 * count, so the app's scrubber can jump and its sections never reshuffle while paging.
 *
 * The letter rule is the client's `letterOf` (lib/friendsIndex.ts) byte for byte: the server orders and the app files,
 * so the two must agree. Pure, so every rule is tested without a database.
 */

/** The head for a name that starts with no letter at all: a digit, an emoji, punctuation. */
export const OTHER = "#"

const LATIN = /^[A-Z]$/
const LETTER = /^\p{L}$/u
const MARKS = /\p{M}/gu

/** "A" for Aarav and Ábhi, "प" for प्रियंका (its own script's first letter, signs dropped), "#" for no letter. */
export function letterOf(name: string): string {
  const first = [...name.trim().normalize("NFD").replace(MARKS, "")][0] ?? ""
  const upper = first.toLocaleUpperCase("en")
  if (LATIN.test(upper)) return upper
  return LETTER.test(first) ? upper : OTHER
}

const heads = new Intl.Collator("en")
const names = new Intl.Collator("en", { sensitivity: "base" })

/** Latin A–Z first, then each other script's letters in their own order, then "#". */
function compareHeads(a: string, b: string): number {
  const rank = (h: string) => (h === OTHER ? 2 : LATIN.test(h) ? 0 : 1)
  return rank(a) - rank(b) || heads.compare(a, b)
}

interface Keyed {
  head: string
  name: string
  userId: string
}

/** A total order: letter head, then name (accent- and case-blind), then id, so a cursor never repeats or skips. */
function compare(a: Keyed, b: Keyed): number {
  return compareHeads(a.head, b.head) || names.compare(a.name, b.name) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
}

/** `?from=`: one letter (folded as a name's first letter is) or "#". Anything else is refused. */
export function parseFrom(raw: string | null): string | undefined | "bad_from" {
  if (raw === null) return undefined
  if (raw === OTHER) return OTHER
  if ([...raw].length !== 1) return "bad_from"
  const head = letterOf(raw)
  return head === OTHER ? "bad_from" : head
}

const encode = (k: Keyed) => Buffer.from(JSON.stringify([k.head, k.name, k.userId])).toString("base64url")

function decode(cursor: string): Keyed | null {
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === "string")) return null
    return { head: p[0], name: p[1], userId: p[2] }
  } catch {
    return null
  }
}

export interface LetterCount {
  letter: string
  count: number
}

export interface ByNamePage<T> {
  items: T[]
  letters: LetterCount[]
  hasMore: boolean
  nextCursor: string | null
}

/**
 * One page of `rows` by name: after `cursor` (the last page's `nextCursor`), or from the first friend filed under
 * `from` or any letter after it (a scrubber letter with no names lands on the next one, as iOS Contacts does).
 * `letters` counts every row, whatever the page.
 */
export function byName<T extends { userId: string; name: string }>(
  rows: readonly T[],
  opts: { limit: number; cursor?: string; from?: string }
): ByNamePage<T> | "bad_cursor" {
  const keyed = rows
    .map((row) => ({ row, key: { head: letterOf(row.name), name: row.name, userId: row.userId } }))
    .sort((a, b) => compare(a.key, b.key))

  const letters: LetterCount[] = []
  for (const { key } of keyed) {
    const last = letters[letters.length - 1]
    if (last?.letter === key.head) last.count++
    else letters.push({ letter: key.head, count: 1 })
  }

  let start = 0
  if (opts.cursor) {
    const after = decode(opts.cursor)
    if (!after) return "bad_cursor"
    start = keyed.findIndex(({ key }) => compare(key, after) > 0)
  } else if (opts.from) {
    const from = opts.from
    start = keyed.findIndex(({ key }) => compareHeads(key.head, from) >= 0)
  }
  if (start === -1) start = keyed.length

  const page = keyed.slice(start, start + opts.limit)
  const hasMore = start + opts.limit < keyed.length
  return {
    items: page.map(({ row }) => row),
    letters,
    hasMore,
    nextCursor: hasMore && page.length ? encode(page[page.length - 1].key) : null,
  }
}
