/**
 * Spotting contact details in a pseudonymous room.
 *
 * ## What this is not
 *
 * It is **not a filter**, and it cannot be one. Every deterministic detector has
 * a next bypass — `9876543210` becomes `nine eight seven`, becomes `n1ne e1ght`,
 * becomes `🅝🅘🅝🅔`, becomes "the number of fingers on two hands, minus one" —
 * and each tightening catches more innocent messages on the way past. A filter
 * that blocks teaches the boundary in one message and then loses sight of the
 * behaviour entirely, which is strictly worse than not blocking: you get the
 * evasion *and* an empty flag stream.
 *
 * So this returns a *suspicion*, the client warns before sending, and the
 * server records a flag. A false positive costs one tap.
 *
 * ## What the harm actually is
 *
 * Not "a phone number was transmitted". Two distinct things:
 *
 * 1. **Someone posting another person's details.** Doxxing, and undetectable
 *    here — the string for "my number" and "her number" is identical. This
 *    catches it only incidentally; the real remedy is the report button.
 * 2. **Moving a conversation off-platform**, where there is no block, no report
 *    and no moderation. That is the one worth a nudge, and it is why the warning
 *    is addressed to the *sender* rather than hidden from the reader.
 *
 * Sharing your own number is your identity to give. The nudge says "the room is
 * anonymous, are you sure", not "you may not".
 *
 * ## Addresses are deliberately not detected
 *
 * "Meet at the Blue Door on MG Road" is an address and is also exactly what an
 * event chat is for. There is no version of that rule that does not fire on the
 * product's main use case.
 */

import type { ModerationResult } from "./types"

/** Word forms of digits, including the ones people actually type. */
const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nought: "0",
  one: "1", won: "1",
  two: "2", to: "2", too: "2",
  three: "3", tree: "3",
  four: "4", for: "4", fore: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8", ate: "8",
  nine: "9",
}

/**
 * Platform names, which are the actual signal for a handle.
 *
 * Keyed on the platform rather than on `@word`, because `@` before a word is
 * how people address each other — "@priya you coming?" is a room working as
 * intended, and a rule that fires on it would fire constantly.
 */
const PLATFORMS = [
  "insta", "instagram", "snap", "snapchat", "whatsapp", "whats app", "wa",
  "telegram", "tg", "signal", "discord", "twitter", "x dot com",
  "facebook", "fb", "linkedin", "tiktok",
]

/** Link shorteners and direct-message deep links that need no handle at all. */
const CONTACT_LINKS = /\b(wa\.me|t\.me|ig\.me|m\.me|snapchat\.com\/add|api\.whatsapp\.com)/i

/** `soooo` → `soo`. Stretching is the cheapest evasion and the cheapest to undo. */
function collapseRuns(text: string): string {
  return text.replace(/(.)\1{2,}/gi, "$1$1")
}

/** Digits standing in for letters. The inverse of the keyword filter's map. */
const LEET_TO_LETTER: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t",
}

function unleet(token: string): string {
  return token.replace(/[013457]/g, (c) => LEET_TO_LETTER[c] ?? c)
}

/**
 * A token's digit value, tolerating stretching and leetspeak.
 *
 * Four forms are tried because no single normalisation serves them all:
 *
 *     three    the literal token — collapsing runs gives "thre", a miss
 *     nineeee  needs every run collapsed to one
 *     n1ne     needs digits read back as letters
 *     s3veeen  needs both
 *
 * **Un-leeting is per token and never global.** Applied to the whole string it
 * would rewrite `9876543210` as `987654321o` and destroy the very thing being
 * looked for. A token that is already all digits never reaches here.
 */
function digitWordFor(token: string): string | undefined {
  const collapse = (t: string) => t.replace(/(.)\1+/g, "$1")
  for (const form of [token, collapse(token), unleet(token), collapse(unleet(token))]) {
    const digit = DIGIT_WORDS[form]
    if (digit) return digit
  }
  return undefined
}

/**
 * Everything that is a digit once you stop pretending it is a letter.
 *
 * Only the substitutions that are safe on a whole string happen here — `|` and
 * `!` really are ones wherever they appear. Reading digits back as *letters*
 * (`n1ne` → `nine`) is per token in `digitWordFor`, because globally it would
 * rewrite `9876543210` as `987654321o` and destroy what is being looked for.
 *
 * Returns a string of digit runs separated by spaces. A token that is neither a
 * number nor a number-word emits a space, so a run only grows while somebody is
 * actually reciting digits.
 */
function digitsIn(text: string): string {
  const normalised = text
    .toLowerCase()
    .replace(/[|!]/g, "1")
    .replace(/[@]/g, "a")
    .replace(/\$/g, "s")

  const tokens = normalised.split(/[^a-z0-9]+/).filter(Boolean)
  let out = ""
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      out += token
      continue
    }
    const asDigit = digitWordFor(token)
    if (asDigit) {
      out += asDigit
      continue
    }
    /*
     * A token that is neither breaks the run.
     *
     * Without this, "I have 2 tickets and 3 friends" concatenates to a digit
     * string that grows with the sentence rather than with anything phone-like.
     */
    out += " "
  }
  return out
}

/**
 * Seven, and the number is a judgement rather than a standard.
 *
 * E.164 allows 7–15 digits, so seven is the shortest thing that can be a real
 * number anywhere. Ten would fit India exactly and miss every short-form and
 * partial ("my last four are..."), which is a common way to hand over a number
 * across two messages.
 *
 * Below seven the false-positive rate stops being worth it: six digits is a
 * PIN, a date, a price, a time.
 */
const MIN_PHONE_DIGITS = 7

export interface ContactInfoFinding {
  kind: "phone" | "handle" | "link"
  /** What to say to the sender. Never shown to the room. */
  hint: string
}

/**
 * Look for contact details. Returns every distinct kind found, or an empty list.
 *
 * Pure and synchronous — this runs on the client before send *and* on the
 * server before persist, from the same module, so the warning a sender sees and
 * the flag a moderator sees can never disagree.
 */
export function findContactInfo(content: string): ContactInfoFinding[] {
  const findings: ContactInfoFinding[] = []
  if (!content?.trim()) return findings

  const runs = digitsIn(content).split(/\s+/).filter(Boolean)
  if (runs.some((run) => run.length >= MIN_PHONE_DIGITS)) {
    findings.push({
      kind: "phone",
      hint: "This looks like a phone number.",
    })
  }

  const flat = collapseRuns(content.toLowerCase()).replace(/[^a-z0-9\s.]/g, " ")
  if (PLATFORMS.some((p) => new RegExp(`\\b${p}\\b`).test(flat))) {
    findings.push({
      kind: "handle",
      hint: "This looks like a social media handle.",
    })
  }

  if (CONTACT_LINKS.test(content)) {
    findings.push({
      kind: "link",
      hint: "This looks like a direct-message link.",
    })
  }

  return findings
}

/**
 * The moderation verdict, which is always `flag` and never `hide`.
 *
 * Deliberately not tunable by a threshold constant. A confidence dial here
 * would eventually be turned up by somebody reasoning that more blocking is
 * more safety, and that is the exact mistake this module's header argues
 * against. If the policy changes, it should change as code with the reasoning
 * attached, not as a number in a config file.
 */
export function checkContactInfo(content: string): ModerationResult | null {
  const findings = findContactInfo(content)
  if (findings.length === 0) return null

  return {
    action: "flag",
    source: "keyword",
    categories: Object.fromEntries(findings.map((f) => [`contact_${f.kind}`, 1])),
    confidence: 1,
    matched: findings.map((f) => f.kind),
    reason: findings.map((f) => f.hint).join(" "),
  }
}

/**
 * The sentence shown above the composer before sending.
 *
 * Names the room's promise rather than a rule: "the room is anonymous" is a
 * reason somebody can agree with, where "this is not allowed" is one they will
 * route around. It also stays true for the case the detector cannot see — that
 * the number might not be theirs to give.
 */
export function contactInfoWarning(findings: readonly ContactInfoFinding[]): string | null {
  if (findings.length === 0) return null
  const what = findings.map((f) => f.hint).join(" ")
  return `${what} This room is anonymous — everyone here sees it. Send anyway?`
}
