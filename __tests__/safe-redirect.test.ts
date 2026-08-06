import { safeRedirect } from "@/lib/safe-redirect"

/**
 * The post-sign-in redirect.
 *
 * `/login?callbackUrl=…` is attacker-supplied by construction — the whole point
 * of the parameter is that a link somewhere else fills it in. Unvalidated it is
 * an open redirect, and the payoff is unusually good: the victim lands on a
 * look-alike sign-in *arriving from the real one*, immediately after typing
 * their password. That is about as convincing as phishing gets.
 */

describe("same-origin paths are allowed", () => {
  it("passes an ordinary path", () => {
    expect(safeRedirect("/dashboard/events")).toBe("/dashboard/events")
  })

  it("keeps a query string and fragment", () => {
    // The invite flow depends on this: /invite?token=… must survive.
    expect(safeRedirect("/invite?token=abc#x")).toBe("/invite?token=abc#x")
  })

  it("falls back when absent", () => {
    expect(safeRedirect(null)).toBe("/dashboard")
    expect(safeRedirect(undefined)).toBe("/dashboard")
    expect(safeRedirect("")).toBe("/dashboard")
  })

  it("honours a custom fallback", () => {
    expect(safeRedirect(null, "/login")).toBe("/login")
  })
})

describe("anything off-origin is refused", () => {
  it("refuses an absolute URL", () => {
    expect(safeRedirect("https://evil.app/login")).toBe("/dashboard")
    expect(safeRedirect("http://evil.app")).toBe("/dashboard")
  })

  it("refuses a protocol-relative URL", () => {
    // The form that gets forgotten: the browser reads `//evil.app` as a HOST,
    // not a path, so a naive startsWith("/") check waves it through.
    expect(safeRedirect("//evil.app")).toBe("/dashboard")
    expect(safeRedirect("//evil.app/login")).toBe("/dashboard")
  })

  it("refuses the backslash variant", () => {
    // Some browsers normalise `/\` to `//`, giving the same escape.
    expect(safeRedirect("/\\evil.app")).toBe("/dashboard")
  })

  it("refuses a javascript: scheme", () => {
    expect(safeRedirect("javascript:alert(1)")).toBe("/dashboard")
  })

  it("refuses a scheme smuggled behind a control character", () => {
    // Browsers strip these while parsing, so the string that passes validation
    // is not the string that gets navigated to.
    expect(safeRedirect("/\tjavascript:alert(1)")).toBe("/dashboard")
    expect(safeRedirect("/\njavascript:alert(1)")).toBe("/dashboard")
    expect(safeRedirect("/\rjavascript:alert(1)")).toBe("/dashboard")
    expect(safeRedirect(" //evil.app")).toBe("/dashboard")
  })

  it("refuses a bare relative path", () => {
    expect(safeRedirect("evil.app")).toBe("/dashboard")
  })

  it("never returns anything that is not a same-origin path", () => {
    // Sweep: whatever comes back must start with exactly one slash.
    const hostile = [
      "https://evil.app",
      "//evil.app",
      "/\\evil.app",
      "javascript:alert(1)",
      "/\tjavascript:alert(1)",
      " //evil.app",
      "evil.app",
      "\\\\evil.app",
    ]
    for (const input of hostile) {
      const out = safeRedirect(input)
      expect(out.startsWith("/")).toBe(true)
      expect(out.startsWith("//")).toBe(false)
    }
  })
})
