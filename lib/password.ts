/**
 * Password rules.
 *
 * Pure, so the rule the reset form shows and the rule the server enforces are
 * the same function rather than two implementations that drift.
 *
 * Deliberately not a strength meter. Composition rules — one uppercase, one
 * digit, one symbol — push people toward `Password1!` and are worse than
 * length, which is why NIST dropped them. Length plus a check against the
 * obvious choices is what actually helps.
 *
 * Pinned by __tests__/password.test.ts.
 */

export const MIN_PASSWORD_LENGTH = 12

/**
 * Words that are the *stem* of a guessable password.
 *
 * Matched after stripping trailing digits and punctuation, because the way a
 * length rule actually gets defeated is `password` → `password1234`. A plain
 * set of literals would be dead code here: almost every common password is
 * under twelve characters, so the length check would reject it first and this
 * list would never fire. Padding it out is exactly what the rule has to catch.
 */
const OBVIOUS_STEMS = new Set([
  "password", "passwd", "passw0rd", "pass",
  "qwerty", "qwertyuiop", "asdfghjkl", "zxcvbnm",
  "iloveyou", "letmein", "welcome", "admin", "administrator",
  "changeme", "secret", "login", "monkey", "dragon", "sunshine",
  "blendn", "blendnadmin",
])

/** Strip trailing digits and punctuation: `password1234!` → `password`. */
function stem(value: string): string {
  return value.toLowerCase().replace(/[\d\W_]+$/u, "")
}

/** Is the whole thing one run of digits, or one keyboard row repeated? */
function isTrivialRun(value: string): boolean {
  if (/^\d+$/.test(value)) return true
  // "abababab", "aaaaaaaaaaaa" — a short unit repeated to reach the length.
  return /^(.{1,4}?)\1{2,}$/.test(value)
}

export type PasswordProblem = "too_short" | "obvious" | "contains_email" | "whitespace_only"

export interface PasswordCheck {
  ok: boolean
  problem?: PasswordProblem
  message?: string
}

export function checkPassword(password: string, email?: string): PasswordCheck {
  if (!password.trim()) {
    return { ok: false, problem: "whitespace_only", message: "Enter a password." }
  }

  // Length is measured on the raw string — a password of twelve spaces is
  // twelve characters, and trimming first would reject it for the wrong reason.
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      problem: "too_short",
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters. Length beats symbols.`,
    }
  }

  const normalised = password.toLowerCase()
  if (OBVIOUS_STEMS.has(stem(normalised)) || isTrivialRun(normalised)) {
    return {
      ok: false,
      problem: "obvious",
      message:
        "That is one of the first passwords anyone would try — adding digits to the end doesn't change that. Pick something else.",
    }
  }

  // The local part of their own address is the single most guessable choice for
  // a specific account, and it survives every length rule.
  if (email) {
    const local = email.split("@")[0]?.toLowerCase()
    if (local && local.length >= 3 && normalised.includes(local)) {
      return {
        ok: false,
        problem: "contains_email",
        message: "Don't build the password out of your email address.",
      }
    }
  }

  return { ok: true }
}
