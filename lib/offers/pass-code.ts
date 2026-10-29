import { createHmac, hkdfSync, timingSafeEqual } from "crypto"

/**
 * The door pass's code (step 12): six characters that change every 30
 * seconds, issued by the server and never computable by the app.
 *
 * The pass on a phone is live: the app fetches the current code while the
 * screen is open and animates around it. Staff type what they see and tap
 * "Redeemed" (lib/offer-actions.ts), and the server checks it against the
 * code for now or the 30 seconds before — so a screenshot, a forwarded image
 * or a photo of somebody else's phone stops working within a minute, and the
 * code proves nothing on its own once redeemed (the redemption is single-use
 * in the database).
 *
 * The key comes from `NEXTAUTH_SECRET` through HKDF with its own label, as
 * `lib/room-handle.ts` derives its keys: `lib/env.ts` already requires the
 * secret at 32+ characters, and nothing else may share this key.
 */

export const PASS_STEP_MS = 30_000
export const PASS_CODE_LENGTH = 6
/** 32 characters, so a byte's low five bits pick one evenly; no 0/O or 1/I to misread at a door. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** What the door says when typed characters cannot be a pass — the ones the alphabet leaves out are the ones easiest to mistype (SCRUM-899). */
export const BAD_CODE_SHAPE = "A pass code is six letters and numbers, never 0, 1, I or O. Check the code and try again."

let derived: { secret: string; key: Buffer } | null = null

function passKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
  // Loudly: an empty key would make every pass forgeable.
  if (!secret) throw new Error("NEXTAUTH_SECRET is required to issue door passes")
  if (derived?.secret !== secret) {
    derived = { secret, key: Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "blendn door-pass v1", 32)) }
  }
  return derived.key
}

export const passStep = (at: Date): number => Math.floor(at.getTime() / PASS_STEP_MS)

/** The code for one send in one 30-second step. */
export function passCode(sendId: string, step: number): string {
  const mac = createHmac("sha256", passKey()).update(`${sendId}:${step}`).digest()
  let code = ""
  for (let i = 0; i < PASS_CODE_LENGTH; i++) code += ALPHABET[mac[i] & 31]
  return code
}

/** What the pass shows now, and when it turns. */
export function currentPass(sendId: string, now: Date): { code: string; rotatesAt: string } {
  const step = passStep(now)
  return { code: passCode(sendId, step), rotatesAt: new Date((step + 1) * PASS_STEP_MS).toISOString() }
}

/** What staff typed, as a code: upper case, spaces and dashes dropped. Null if it cannot be one. */
export function normaliseCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, "")
  return code.length === PASS_CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null
}

/** Does this code match the pass now, or as it was a step ago (a code read out as it turns)? */
export function codeMatches(sendId: string, code: string, now: Date): boolean {
  const step = passStep(now)
  const typed = Buffer.from(code)
  return [step, step - 1].some((s) => {
    const want = Buffer.from(passCode(sendId, s))
    return want.length === typed.length && timingSafeEqual(want, typed)
  })
}
