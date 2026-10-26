/**
 * The public policy pages Razorpay's website verification reads
 * (docs/RAZORPAY-VERIFICATION.md) answer without a session, exist, and show
 * the Terms whole.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { POLICY_LINKS } from "@/lib/company"
import { termsBody } from "@/lib/legal-html"

const root = path.join(__dirname, "..")

describe("the policy pages are public", () => {
  // Read as text: importing middleware.ts pulls next-auth into jest.
  const middleware = readFileSync(path.join(root, "middleware.ts"), "utf8")
  const matcher = /matcher:\s*\[([\s\S]*?)\]/.exec(middleware)?.[1] ?? ""
  const patterns = [...matcher.matchAll(/"([^"]+)"/g)].map((m) => m[1])

  it("found the matcher", () => {
    expect(patterns).toContain("/dashboard/:path*")
  })

  it.each(POLICY_LINKS.map((l) => [l.href]))("%s is outside the middleware matcher, so no sign-in", (href) => {
    for (const p of patterns) {
      const prefix = p.replace(/\/:path\*$/, "")
      expect(href === p || href.startsWith(`${prefix}/`) || href === prefix).toBe(false)
    }
  })

  it.each(POLICY_LINKS.map((l) => [l.href]))("%s has a page", (href) => {
    expect(existsSync(path.join(root, "app", href, "page.tsx"))).toBe(true)
  })

  it("the sign-in page links every one", () => {
    expect(readFileSync(path.join(root, "app/login/page.tsx"), "utf8")).toMatch(/POLICY_LINKS\.map/)
  })
})

describe("termsBody", () => {
  const html = readFileSync(path.join(root, "docs/legal/terms-of-use.html"), "utf8")
  const { updated, body } = termsBody(html)

  it("dates the page from the file", () => {
    expect(updated).toBe("26 October 2026")
    expect(body).not.toMatch(/Last updated/)
  })

  it("leaves no div open, so the seller footer stays outside the terms", () => {
    const opened = (body.match(/<div\b/g) ?? []).length
    const closed = (body.match(/<\/div>/g) ?? []).length
    expect(opened).toBe(closed)
  })

  it("keeps every section the table of contents links to, the payments one included", () => {
    const targets = [...body.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(30)
    for (const id of targets) expect(body).toContain(`id="${id}"`)
    expect(body).toMatch(/PAID PLANS AND PAYMENTS/)
    expect(body).toMatch(/dashboard\.blendn\.app\/refunds/)
  })

  it("carries nothing that runs: no script, no inline handler, no javascript: link", () => {
    expect(body).not.toMatch(/<script/i)
    expect(body).not.toMatch(/\son\w+\s*=/i)
    expect(body).not.toMatch(/javascript:/i)
  })

  it("names the legal entity", () => {
    expect(body).toMatch(/Matryx Social Labs Private Limited/)
  })
})
