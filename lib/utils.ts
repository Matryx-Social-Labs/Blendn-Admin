import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Characters as a person counts them, and as Postgres's `char_length` does: code points ("🎉" is one). */
export const characters = (text: string): number => [...text].length

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * At most `max` characters of `text`, counted as `characters` counts them, and
 * cut only between graphemes: a family, a flag or a skin tone is kept whole or
 * left out, never halved (SCRUM-1033). `String#slice` counts UTF-16 units and
 * can split a surrogate pair, which draws as "�".
 */
export function clipCharacters(text: string, max: number): string {
  if (characters(text) <= max) return text
  let clipped = ""
  let count = 0
  for (const { segment } of graphemes.segment(text)) {
    count += characters(segment)
    if (count > max) break
    clipped += segment
  }
  return clipped
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Up to two initials for an avatar; "B" when the name has none. */
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "B"
  )
}
