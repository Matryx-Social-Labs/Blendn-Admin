import { validateGstin, gstinMessage } from "@/lib/gstin"

/**
 * The checksum is the whole value here, so it gets tested against a number
 * whose check digit is computed rather than asserted from memory — a
 * hand-written "known good" that is actually wrong would make every other case
 * pass for the wrong reason.
 *
 * What this cannot do is prove a GSTIN is *registered*. That needs a paid
 * provider; the queue shows this result for a human to weigh.
 */

/** Build a valid GSTIN by computing the correct final digit. */
function withValidCheckDigit(first14: string): string {
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const weighted = ALPHABET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(weighted / 36) + (weighted % 36)
  }
  return first14 + ALPHABET[(36 - (sum % 36)) % 36]
}

const VALID = withValidCheckDigit("29ABCDE1234F1Z")

describe("validateGstin", () => {
  it("accepts a well-formed GSTIN and extracts state and PAN", () => {
    const r = validateGstin(VALID)
    expect(r.valid).toBe(true)
    if (r.valid) {
      expect(r.stateCode).toBe("29")
      expect(r.pan).toBe("ABCDE1234F")
    }
  })

  it("is case- and whitespace-insensitive", () => {
    expect(validateGstin(`  ${VALID.toLowerCase()}  `).valid).toBe(true)
  })

  it("rejects a transposed character", () => {
    // The case the checksum exists for — right length, right shape, wrong number.
    const transposed = VALID.slice(0, 2) + VALID[3] + VALID[2] + VALID.slice(4)
    const r = validateGstin(transposed)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toBe("checksum")
  })

  it("rejects a wrong check digit", () => {
    const wrong = VALID.slice(0, 14) + (VALID[14] === "0" ? "1" : "0")
    const r = validateGstin(wrong)
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toBe("checksum")
  })

  it("rejects an unassigned state code", () => {
    const r = validateGstin(withValidCheckDigit("00ABCDE1234F1Z"))
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toBe("state")
  })

  it("rejects wrong length and obvious junk", () => {
    for (const bad of ["", "29ABCDE1234F1Z", "not-a-gstin", "29ABCDE1234F1Z55"]) {
      const r = validateGstin(bad)
      expect(r.valid).toBe(false)
      if (!r.valid) expect(r.reason).toBe("format")
    }
  })

  it("never claims a valid number is registered", () => {
    // The message is what an admin reads before approving; overstating it is
    // how a checksum pass becomes mistaken for a background check.
    expect(gstinMessage(validateGstin(VALID))).toContain("Not verified as registered")
  })
})
