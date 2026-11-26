import { createHmac, hkdfSync, timingSafeEqual } from "crypto"

/**
 * A six-character code that changes every 30 seconds, issued by the server and
 * never computable by the app: the offer pass's (`lib/offers/pass-code.ts`)
 * and the event's door code (`lib/entry-code.ts`), each under its own HKDF
 * label, so neither key opens the other.
 *
 * The key comes from `NEXTAUTH_SECRET` through HKDF, as `lib/room-handle.ts`
 * derives its keys: `lib/env.ts` already requires the secret at 32+
 * characters.
 */

export const CODE_STEP_MS = 30_000
export const CODE_LENGTH = 6
/** 32 characters, so a byte's low five bits pick one evenly; no 0/O or 1/I to misread at a door. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const keys = new Map<string, { secret: string; key: Buffer }>()

function keyFor(label: string): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
  // Loudly: an empty key would make every code forgeable.
  if (!secret) throw new Error("NEXTAUTH_SECRET is required to issue rotating codes")
  const known = keys.get(label)
  if (known?.secret === secret) return known.key
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), label, 32))
  keys.set(label, { secret, key })
  return key
}

export const codeStep = (at: Date): number => Math.floor(at.getTime() / CODE_STEP_MS)

/** What a person typed, as a code: upper case, spaces and dashes dropped. Null if it cannot be one. */
export function normaliseCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, "")
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null
}

/** One label's codes: the code for a subject in a step, the current one, and how many steps back a typed one is. */
export function rotatingCode(label: string) {
  const code = (subject: string, step: number): string => {
    const mac = createHmac("sha256", keyFor(label)).update(`${subject}:${step}`).digest()
    let out = ""
    for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[mac[i] & 31]
    return out
  }

  return {
    code,
    /** What the screen shows now, and when it turns. */
    current(subject: string, now: Date): { code: string; rotatesAt: string } {
      const step = codeStep(now)
      return { code: code(subject, step), rotatesAt: new Date((step + 1) * CODE_STEP_MS).toISOString() }
    },
    /**
     * How many steps back (0 to `depth`) the normalised code is, or null. Every
     * step is compared, each timing-safe, whatever matches first; `fold` maps
     * both sides before the compare.
     */
    stepsBack(subject: string, typed: string, now: Date, depth: number, fold: (c: string) => string = (c) => c): number | null {
      const step = codeStep(now)
      const mine = Buffer.from(fold(typed))
      let found: number | null = null
      for (let back = 0; back <= depth; back++) {
        const want = Buffer.from(fold(code(subject, step - back)))
        if (want.length === mine.length && timingSafeEqual(want, mine) && found === null) found = back
      }
      return found
    },
  }
}
