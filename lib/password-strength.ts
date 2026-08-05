/**
 * Password strength, and the minimum we will accept.
 *
 * Deliberately not a dependency. zxcvbn is 800 kB of dictionary to tell a host
 * in Bengaluru that "bygbrewski2024" is guessable — real value at consumer
 * scale, but this is a dashboard with a handful of accounts behind a rate
 * limiter, and the shipping cost is the whole bundle.
 *
 * What this does instead is the part that actually blocks bad passwords: a
 * length floor, a character-variety score, and a refusal of the handful of
 * strings people genuinely type when told to pick a password.
 *
 * Pinned by __tests__/password-strength.test.ts.
 */

/** Below this we refuse outright, regardless of variety. */
export const MIN_LENGTH = 10

export type StrengthScore = 0 | 1 | 2 | 3 | 4

export interface Strength {
  score: StrengthScore
  label: string
  /** Whether this password may be submitted at all. */
  acceptable: boolean
  /** The single most useful next step, or null when it is already strong. */
  advice: string | null
}

/*
 * Not a password list — those belong in a file, and a 100k-entry list is the
 * dependency this avoids. These are the shapes that survive a length rule:
 * keyboard walks and the words people reach for when a form demands a password.
 */
const OBVIOUS = [
  "password", "passw0rd", "qwerty", "asdfgh", "zxcvbn", "letmein", "welcome",
  "admin", "administrator", "changeme", "iloveyou", "monkey", "dragon",
  "abc123", "123456", "12345678", "987654321", "blendn", "test1234",
]

/** Normalised for matching: case-folded, with common letter/digit swaps undone. */
function deleet(value: string): string {
  return value
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t")
}

/** Three or more of the same character, or a run like `abcd` / `4321`. */
function hasWeakRun(value: string): boolean {
  const lower = value.toLowerCase()
  if (/(.)\1{2,}/.test(lower)) return true
  for (let i = 0; i + 3 < lower.length + 1 && i + 3 <= lower.length; i++) {
    const chunk = lower.slice(i, i + 4)
    if (chunk.length < 4) break
    let ascending = true
    let descending = true
    for (let j = 1; j < chunk.length; j++) {
      const step = chunk.charCodeAt(j) - chunk.charCodeAt(j - 1)
      if (step !== 1) ascending = false
      if (step !== -1) descending = false
    }
    if (ascending || descending) return true
  }
  return false
}

export function passwordStrength(raw: string, context: { email?: string; name?: string } = {}): Strength {
  const value = raw ?? ""

  if (value.length === 0) {
    return { score: 0, label: "", acceptable: false, advice: null }
  }

  if (value.length < MIN_LENGTH) {
    return {
      score: 1,
      label: "Too short",
      acceptable: false,
      advice: `At least ${MIN_LENGTH} characters.`,
    }
  }

  const normalised = deleet(value)

  if (OBVIOUS.some((word) => normalised.includes(word))) {
    return {
      score: 1,
      label: "Too common",
      acceptable: false,
      advice: "That contains a very common password. Pick something unrelated.",
    }
  }

  // A password containing your own name or the local part of your email is
  // guessable by anyone who has emailed you.
  const local = context.email?.split("@")[0]?.toLowerCase()
  for (const personal of [local, context.name?.toLowerCase()]) {
    if (personal && personal.length >= 4 && normalised.includes(personal)) {
      return {
        score: 1,
        label: "Too personal",
        acceptable: false,
        advice: "Avoid your own name or email address.",
      }
    }
  }

  if (hasWeakRun(value)) {
    return {
      score: 2,
      label: "Predictable",
      acceptable: false,
      advice: "Avoid repeated characters and sequences like 1234 or abcd.",
    }
  }

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length
  const long = value.length >= 16

  // Length beats variety, which is why a long two-class password scores as well
  // as a short four-class one.
  if (long || variety >= 3) {
    const strong = long && variety >= 3
    return {
      score: strong ? 4 : 3,
      label: strong ? "Strong" : "Good",
      acceptable: true,
      advice: strong ? null : "Longer is the easiest way to make it stronger.",
    }
  }

  return {
    score: 2,
    label: "Weak",
    acceptable: false,
    advice: "Add another kind of character, or make it 16+ characters long.",
  }
}
