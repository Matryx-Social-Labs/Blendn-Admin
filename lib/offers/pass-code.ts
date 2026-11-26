import { CODE_STEP_MS, codeStep, normaliseCode, rotatingCode } from "@/lib/rotating-code"

/**
 * The door pass's code (step 12): six characters that change every 30
 * seconds, issued by the server and never computable by the app
 * (`lib/rotating-code.ts`, label `blendn door-pass v1`).
 *
 * The pass on a phone is live: the app fetches the current code while the
 * screen is open and animates around it. Staff type what they see and tap
 * "Redeemed" (lib/offer-actions.ts), and the server checks it against the
 * code for now or the 30 seconds before — so a screenshot, a forwarded image
 * or a photo of somebody else's phone stops working within a minute, and the
 * code proves nothing on its own once redeemed (the redemption is single-use
 * in the database).
 */

export const PASS_STEP_MS = CODE_STEP_MS
export const passStep = codeStep
export { normaliseCode }

/** What the door says when typed characters cannot be a pass — the ones the alphabet leaves out are the ones easiest to mistype (SCRUM-899). */
export const BAD_CODE_SHAPE = "An offer code is six letters and numbers, never 0, 1, I or O. Check the code and try again."

const pass = rotatingCode("blendn door-pass v1")

/** The code for one send in one 30-second step. */
export const passCode = (sendId: string, step: number): string => pass.code(sendId, step)

/** What the pass shows now, and when it turns. */
export function currentPass(sendId: string, now: Date): { code: string; rotatesAt: string } {
  const step = codeStep(now)
  return { code: passCode(sendId, step), rotatesAt: new Date((step + 1) * CODE_STEP_MS).toISOString() }
}

/** Does this code match the pass now, or as it was a step ago (a code read out as it turns)? */
export function codeMatches(sendId: string, code: string, now: Date): boolean {
  return pass.stepsBack(sendId, code, now, 1) !== null
}
