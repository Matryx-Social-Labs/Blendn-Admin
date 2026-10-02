/**
 * Text folded to what a reader sees, before any check reads it.
 *
 * A filter that reads code points can be walked around by changing code
 * points a person cannot tell apart: fullwidth `９８４５`, Devanagari `९८४५`,
 * a zero-width space after an `@`, Cyrillic `а` for Latin `a`, U+2024 `․` for
 * a dot, a right-to-left override that renders a number backwards. Each one
 * passed the crew-name checks (PR #630 security review). Folding first means
 * the keyword filter, the contact-detail detector and OpenAI all read the
 * same thing the screen will show — and the folded form is what is stored, so
 * nothing slips past the check by being re-rendered differently later.
 *
 * Three steps, in order:
 *
 * 1. **NFKC** — compatibility forms to their ordinary ones: fullwidth and
 *    mathematical digits and letters, ligatures, U+2024 to `.`.
 * 2. **No format characters** (`\p{Cf}`): zero-width spaces and joiners,
 *    bidi overrides and marks, the soft hyphen. Invisible by definition. The
 *    one kept is an emoji's own joiner (`INVISIBLE`).
 * 3. **Confusables** — every decimal digit of any script to ASCII, and the
 *    Cyrillic and Greek letters that look Latin to their Latin twins.
 *
 * ponytail: a hand-picked confusables table, not Unicode's full
 * confusables.txt (~6k entries). It covers the scripts a crew name in India
 * is likely to borrow from to dodge a filter; add the full table if a report
 * ever shows a bypass through another script.
 */

/**
 * Format characters (`\p{Cf}`): invisible, and never needed in a name — except
 * the zero-width joiner inside an emoji sequence (👯‍♀️, 🏳️‍🌈), which is how
 * those emoji are spelled, and which cannot smuggle a digit or a letter.
 */
const INVISIBLE = /(?!(?<=\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic}))\p{Cf}/gu

/** Cyrillic and Greek letters drawn like Latin ones (lower and upper). */
const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "е": "e", "ё": "e", "і": "i", "ї": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "о": "o",
  "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s", "ԁ": "d", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ɡ": "g",
  "А": "A", "В": "B", "Е": "E", "Ё": "E", "І": "I", "Ї": "I", "Ј": "J", "К": "K", "М": "M", "Н": "H", "О": "O",
  "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X", "Ѕ": "S", "Ԁ": "D", "Ӏ": "I", "Ԛ": "Q", "Ԝ": "W",
  // Greek
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P",
  "Τ": "T", "Υ": "Y", "Χ": "X",
}

const DIGIT = /\p{Nd}/u

/**
 * A decimal digit of any script, as its ASCII digit. Unicode lays every
 * script's digits out as one run of ten, zero first, so the value is the
 * distance back to the start of the run.
 */
function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0)!
  if (cp >= 0x30 && cp <= 0x39) return ch
  let zero = cp
  while (cp - zero < 9 && DIGIT.test(String.fromCodePoint(zero - 1))) zero--
  return String(cp - zero)
}

/** The text as the checks and the database see it. Pure. */
export function foldText(text: string): string {
  const out: string[] = []
  for (const ch of text.normalize("NFKC").replace(INVISIBLE, "")) {
    out.push(DIGIT.test(ch) ? asciiDigit(ch) : (CONFUSABLE[ch] ?? ch))
  }
  return out.join("")
}

/** Whether the text carries an invisible format character (an emoji's joiner aside). */
export function hasInvisibleChars(text: string): boolean {
  return text.normalize("NFKC").replace(INVISIBLE, "") !== text.normalize("NFKC")
}
