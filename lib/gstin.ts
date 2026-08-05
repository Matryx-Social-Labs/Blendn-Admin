/**
 * GSTIN validation, offline.
 *
 * **This checks the number is well-formed, not that it is registered.** There
 * is no free official verification API — the GST portal requires GSP
 * accreditation, and confirming a GSTIN belongs to a named business means a
 * paid provider. So this catches typos and invented numbers instantly at zero
 * cost, and the review queue shows the result for a human to weigh rather than
 * treating a pass as proof.
 *
 * Format, 15 characters:
 *   [0-1]   state code, 01-38
 *   [2-11]  PAN of the entity
 *   [12]    entity number for that PAN in that state
 *   [13]    'Z' by convention
 *   [14]    check digit
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const GSTIN_SHAPE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export type GstinResult =
  | { valid: true; stateCode: string; pan: string }
  | { valid: false; reason: "format" | "state" | "checksum" }

/**
 * The check digit is a weighted mod-36 sum: each character's alphabet index is
 * multiplied by 1 or 2 alternating, the product's own digits in base 36 are
 * summed, and the total's complement to the next multiple of 36 is the digit.
 */
function checkDigit(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(first14[i])
    const weighted = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(weighted / 36) + (weighted % 36)
  }
  return ALPHABET[(36 - (sum % 36)) % 36]
}

export function validateGstin(raw: string): GstinResult {
  const gstin = raw.trim().toUpperCase()

  if (!GSTIN_SHAPE.test(gstin)) return { valid: false, reason: "format" }

  // 01-38 are assigned; 00 and 39+ are not real states, and a transposition
  // that lands there should be caught here rather than by the checksum.
  const stateCode = gstin.slice(0, 2)
  const state = Number(stateCode)
  if (state < 1 || state > 38) return { valid: false, reason: "state" }

  if (checkDigit(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, reason: "checksum" }
  }

  return { valid: true, stateCode, pan: gstin.slice(2, 12) }
}

/** Human-readable reason for the review queue. */
export function gstinMessage(result: GstinResult): string {
  if (result.valid) return `Well-formed. State ${result.stateCode}, PAN ${result.pan}. Not verified as registered.`
  return {
    format: "Not a valid GSTIN format — 15 characters, state code + PAN + entity + Z + check digit.",
    state: "State code is not one of 01-38.",
    checksum: "Check digit does not match — usually a typo or a transposed character.",
  }[result.reason]
}
