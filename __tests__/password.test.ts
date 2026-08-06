import { checkPassword, MIN_PASSWORD_LENGTH } from "@/lib/password"

/**
 * Password rules.
 *
 * The rule the form shows and the rule the server enforces are this one
 * function, so they cannot drift into a form that says "looks good" over a
 * server that returns 400.
 */

describe("length is the rule that matters", () => {
  it("accepts a long ordinary passphrase", () => {
    expect(checkPassword("correct horse battery staple").ok).toBe(true)
  })

  it("rejects anything under the minimum", () => {
    const r = checkPassword("Short1!")
    expect(r.ok).toBe(false)
    expect(r.problem).toBe("too_short")
    expect(r.message).toContain(String(MIN_PASSWORD_LENGTH))
  })

  it("accepts exactly the minimum", () => {
    // A real password of exactly the minimum length. `"a".repeat(12)` would be
    // the obvious way to write this and is correctly rejected as a repeated
    // unit — twelve of the same character is no harder to guess than one.
    const twelve = "marbleThund7"
    expect(twelve).toHaveLength(MIN_PASSWORD_LENGTH)
    expect(checkPassword(twelve).ok).toBe(true)
  })

  it("does not demand symbols, digits or mixed case", () => {
    // Composition rules push people to "Password1!" — worse than length, which
    // is why NIST dropped them.
    expect(checkPassword("thequickbrownfoxjumps").ok).toBe(true)
  })

  it("measures the raw string, not a trimmed one", () => {
    // Twelve spaces is twelve characters. It gets rejected for being obvious
    // or empty-ish, never for a length it actually has.
    const r = checkPassword("            ")
    expect(r.problem).toBe("whitespace_only")
  })

  it("rejects an empty password", () => {
    expect(checkPassword("").ok).toBe(false)
    expect(checkPassword("   ").problem).toBe("whitespace_only")
  })
})

describe("the obvious choices are refused", () => {
  it("rejects a classic padded out to pass the length rule", () => {
    // This is how a length rule actually gets defeated. Every one of these is
    // 12+ characters and would sail past a naive check.
    for (const p of ["password1234", "letmein12345", "welcome123456", "qwerty123456"]) {
      const r = checkPassword(p)
      expect(r.ok).toBe(false)
      expect(r.problem).toBe("obvious")
    }
  })

  it("is case-insensitive about it", () => {
    expect(checkPassword("PASSWORD1234").problem).toBe("obvious")
    expect(checkPassword("PaSsWoRd1234").problem).toBe("obvious")
  })

  it("rejects trailing punctuation as padding too", () => {
    expect(checkPassword("password1234!").problem).toBe("obvious")
    expect(checkPassword("letmein!!!!!!!").problem).toBe("obvious")
  })

  it("rejects a long run of digits", () => {
    expect(checkPassword("123456789012345").problem).toBe("obvious")
  })

  it("rejects a short unit repeated to reach the length", () => {
    // "abababababab" is twelve characters and no harder to guess than "ab".
    expect(checkPassword("abababababab").problem).toBe("obvious")
    expect(checkPassword("aaaaaaaaaaaaaa").problem).toBe("obvious")
  })

  it("rejects the product's own name padded out", () => {
    // The first thing anyone tries against this specific product.
    expect(checkPassword("blendnadmin1").ok).toBe(false)
  })

  it("does not reject a passphrase that merely contains a common word", () => {
    expect(checkPassword("my password is a secret").ok).toBe(true)
  })
})

describe("the password must not be built from the email", () => {
  it("rejects the local part", () => {
    const r = checkPassword("asharaoasharao", "asharao@byg.in")
    expect(r.ok).toBe(false)
    expect(r.problem).toBe("contains_email")
  })

  it("rejects it case-insensitively and as a substring", () => {
    expect(checkPassword("xxAshaRaoxxxxxx", "asharao@byg.in").problem).toBe("contains_email")
  })

  it("ignores a very short local part", () => {
    // "jo@x.com" would otherwise reject every password containing "jo" —
    // including "jonathan is my favourite".
    expect(checkPassword("jo is a nice person", "jo@x.com").ok).toBe(true)
  })

  it("passes when no email is supplied", () => {
    expect(checkPassword("a perfectly fine passphrase").ok).toBe(true)
  })

  it("passes an unrelated password", () => {
    expect(checkPassword("thunder marble seventeen", "asharao@byg.in").ok).toBe(true)
  })
})
