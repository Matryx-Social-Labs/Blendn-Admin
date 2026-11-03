import { createHash } from "crypto"

import { organizerTicketingTermsBody, readOrganizerTicketingTerms } from "@/lib/legal-html"

/**
 * The Organizer Ticketing Terms as shown and hashed (SCRUM-1014): only what is
 * between the file's markers, and a hash that moves with a single character,
 * so `document_sha256` proves which words were accepted.
 */
const doc = (body: string) => `<html><body><!-- not shown --><!-- terms:start -->\n${body}\n<!-- terms:end --><footer>not shown</footer></body></html>`
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

describe("the organizer ticketing terms' body and hash", () => {
  it("is the text between the markers, trimmed, and its sha256", () => {
    const shown = organizerTicketingTermsBody(doc("<p>One.</p>"), "0.1")
    expect(shown).toEqual({ version: "0.1", body: "<p>One.</p>", sha256: sha("<p>One.</p>") })
  })

  it("hashes differently when one character of the shown text changes, and not when the unshown part does", () => {
    const a = organizerTicketingTermsBody(doc("<p>Payouts held 3 days.</p>"), "0.1").sha256
    expect(organizerTicketingTermsBody(doc("<p>Payouts held 4 days.</p>"), "0.1").sha256).not.toBe(a)
    expect(organizerTicketingTermsBody(doc("<p>Payouts held 3 days.</p>").replace("not shown</footer>", "changed</footer>"), "0.1").sha256).toBe(a)
  })

  it("refuses a file without its markers rather than hashing the wrong text", () => {
    expect(() => organizerTicketingTermsBody("<p>no markers</p>", "0.1")).toThrow(/markers/)
  })

  it("the committed file is marked DRAFT and carries sections 1 to 12, not the buyer terms or the build notes", () => {
    const { body } = readOrganizerTicketingTerms()
    expect(body).toMatch(/DRAFT v0\.1/)
    expect(body).toMatch(/1\. What we do and what you do/)
    expect(body).toMatch(/12\. General/)
    expect(body).not.toMatch(/How acceptance works|Buyer terms of sale/)
  })
})
