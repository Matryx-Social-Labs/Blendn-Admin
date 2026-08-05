import { passwordStrength, MIN_LENGTH } from "@/lib/password-strength"

/**
 * Password strength.
 *
 * This is the gate on the only credential a host has, and the failure mode is
 * accepting something guessable — which looks identical to working correctly
 * right up until the account is taken. So the refusals are asserted, not the
 * happy path.
 */

describe("length floor", () => {
  it("refuses anything under the minimum", () => {
    expect(passwordStrength("Ab1!x").acceptable).toBe(false)
    expect(passwordStrength("a".repeat(MIN_LENGTH - 1)).acceptable).toBe(false)
  })

  it("says how long it needs to be, rather than just refusing", () => {
    expect(passwordStrength("short").advice).toContain(String(MIN_LENGTH))
  })

  it("scores an empty box as nothing at all, with no scolding", () => {
    // Someone who has not typed yet has not done anything wrong.
    const s = passwordStrength("")
    expect(s.score).toBe(0)
    expect(s.label).toBe("")
    expect(s.advice).toBeNull()
  })
})

describe("obvious passwords are refused however they are dressed up", () => {
  it("rejects the classics", () => {
    for (const bad of ["password123", "qwertyuiop", "letmein12345", "welcome2024"]) {
      expect(passwordStrength(bad).acceptable).toBe(false)
    }
  })

  it("sees through leetspeak", () => {
    // p@ssw0rd passes a naive length-plus-variety check with flying colours.
    for (const bad of ["p@ssw0rd123", "P4ssw0rd!!", "l3tm31n1234"]) {
      const s = passwordStrength(bad)
      expect(s.acceptable).toBe(false)
    }
  })

  it("rejects the product name", () => {
    expect(passwordStrength("blendn2026!").acceptable).toBe(false)
  })
})

describe("personal passwords are refused", () => {
  it("rejects one containing the email local part", () => {
    const s = passwordStrength("priya-brewski-99", { email: "priya@bygbrewski.in" })
    expect(s.acceptable).toBe(false)
    expect(s.label).toBe("Too personal")
  })

  it("rejects one containing the account name", () => {
    expect(passwordStrength("natarajan!2026", { name: "Natarajan" }).acceptable).toBe(false)
  })

  it("ignores a very short local part rather than banning a common substring", () => {
    // An email of `jo@x.com` must not ban every password containing "jo".
    expect(passwordStrength("Tr0ubadour-Fjord", { email: "jo@x.com" }).acceptable).toBe(true)
  })
})

describe("predictable runs are refused", () => {
  it("rejects repeated characters", () => {
    expect(passwordStrength("Trrrrouble1!").acceptable).toBe(false)
  })

  it("rejects ascending and descending sequences", () => {
    for (const bad of ["Trouble1234!", "Trouble4321!", "Troubleabcd!"]) {
      expect(passwordStrength(bad).acceptable).toBe(false)
    }
  })

  it("does not reject an incidental pair", () => {
    // "ll" in "hello" is two, not three — banning it would reject half of
    // English.
    expect(passwordStrength("Hollow-Trumpet7").acceptable).toBe(true)
  })
})

describe("what passes", () => {
  it("accepts a long passphrase with only two character classes", () => {
    // Length beats variety. Refusing this while accepting "Ab1!efgh" would be
    // the rule working backwards.
    const s = passwordStrength("correcthorsebatterystaple")
    expect(s.acceptable).toBe(true)
    expect(s.score).toBeGreaterThanOrEqual(3)
  })

  it("accepts a shorter password with three classes", () => {
    expect(passwordStrength("Wombat-Fjord7").acceptable).toBe(true)
  })

  it("scores long AND varied as Strong, with nothing left to advise", () => {
    const s = passwordStrength("Wombat-Fjord-Marmalade7")
    expect(s.label).toBe("Strong")
    expect(s.score).toBe(4)
    expect(s.advice).toBeNull()
  })

  it("tells a Good password the single most useful next step", () => {
    const s = passwordStrength("Wombat-Fjord7")
    expect(s.label).toBe("Good")
    expect(s.advice).toMatch(/longer/i)
  })

  it("refuses a long password of one repeated character", () => {
    // Length alone is not enough when the length is a lie.
    expect(passwordStrength("aaaaaaaaaaaaaaaaaaaa").acceptable).toBe(false)
  })
})

describe("the score is usable as a meter", () => {
  it("stays within 0-4", () => {
    for (const p of ["", "abc", "password1", "Wombat-Fjord7", "Wombat-Fjord-Marmalade7"]) {
      const { score } = passwordStrength(p)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(4)
    }
  })

  it("never marks anything below 3 as acceptable", () => {
    // The meter and the gate must agree, or the bar fills green on a password
    // the form then refuses.
    for (const p of ["short", "password123", "Trouble1234!", "aaaaaaaaaaaa"]) {
      const s = passwordStrength(p)
      if (!s.acceptable) expect(s.score).toBeLessThan(3)
    }
  })
})
