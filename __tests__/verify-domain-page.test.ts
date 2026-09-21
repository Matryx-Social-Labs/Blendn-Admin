import { existsSync, readFileSync } from "fs"
import { join } from "path"

/*
 * The domain-verification email links to a page that exists (SCRUM-189).
 *
 * Driven on staging: claim blendn.app → "Email instead" → admin@blendn.app →
 * the mail arrived, and its link was a 404. `sendDomainVerifyEmail` built
 * `/verify-domain?token=` and no route answered it, so the one path an org
 * without DNS access has could never complete. Nothing typechecks a URL
 * against the file system; this does.
 */
const root = join(__dirname, "..")
const actions = readFileSync(join(root, "lib", "org-actions.ts"), "utf8")
const pagePath = join(root, "app", "verify-domain", "page.tsx")

describe("the domain-verification link", () => {
  const link = actions.match(/NEXTAUTH_URL \?\? ""\}(\/[\w-]+)\?token=/)

  it("is built from a path", () => {
    expect(link).not.toBeNull()
  })

  it("lands on a page at that path", () => {
    expect(link![1]).toBe("/verify-domain")
    expect(existsSync(pagePath)).toBe(true)
  })

  it("is spent by a POST to the verifier, not by loading the page", () => {
    const page = readFileSync(pagePath, "utf8")
    expect(page).toContain('fetch("/api/org/domains/verify"')
    expect(page).toMatch(/method: "POST"/)
    // The token travels in the body, hashed server-side — never in the URL of
    // a GET a mail client could prefetch.
    expect(page).toContain("JSON.stringify({ token })")
  })
})
