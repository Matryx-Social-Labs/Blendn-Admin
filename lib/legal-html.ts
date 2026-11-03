import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

import { ORGANIZER_TICKETING_TERMS } from "./legal-acceptance"

/**
 * The Terms of Use's body, cut out of its standalone HTML page
 * (`docs/legal/terms-of-use.html`) so `/terms` can show it inside the policy
 * pages' frame: from the table of contents to the page's own footer.
 *
 * The file was exported from a generator that opens an anchor `<div id="…">`
 * before each section and never closes it. Rendered as-is inside our frame,
 * the browser would close them against our own `</div>`s and pull the seller
 * footer into the last section. Each opener becomes an empty `<span>` with the
 * same id (the stray `</a>` after one goes), so the in-text links to
 * "PROHIBITED ACTIVITIES" and the like still land, and nothing nests.
 * `policy-pages-public.test.ts` holds the result balanced.
 */
export function termsBody(html: string): { updated: string; body: string } {
  const start = html.indexOf('<nav class="toc">')
  const end = html.indexOf('<div class="footer">')
  if (start < 0 || end < start) throw new Error("terms-of-use.html: table of contents or footer not found")
  const updated = /Last updated ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(html)?.[1]
  if (!updated) throw new Error("terms-of-use.html: no 'Last updated' date")

  const body = html
    .slice(start, end)
    // The date is the frame's to say, once.
    .replace(/<p>Last updated [^<]*<\/p>\s*/g, "")
    .replace(/<div id="([^"]*)">(<\/a>)?/g, '<span id="$1"></span>')
    // Empty links the generator left: to its request form, and to a "#dmca" section the file never had.
    .replace(/<a href="(https:\/\/app\.termly\.io|#)[^"]*"><\/a>/g, "")
  return { updated: toDayMonthYear(updated), body }
}

/** "October 26, 2026" → "26 October 2026", the way every other page dates itself. */
function toDayMonthYear(us: string): string {
  const [month, day, year] = us.replace(",", "").split(" ")
  return `${day} ${month} ${year}`
}

const TERMS_START = "<!-- terms:start -->"
const TERMS_END = "<!-- terms:end -->"

export interface ShownTerms {
  version: string
  /** The HTML shown, exactly: what the panel and the public page render. */
  body: string
  /** sha256, hex, of `body` as UTF-8: what `legal_acceptances.document_sha256` records. */
  sha256: string
}

/**
 * The Organizer Ticketing Terms' body, cut from `docs/legal/organizer-ticketing-terms.html`
 * between its two markers (SCRUM-1014). Pure, so the cut and the hash are tested without a file.
 */
export function organizerTicketingTermsBody(html: string, version: string): ShownTerms {
  const start = html.indexOf(TERMS_START)
  const end = html.indexOf(TERMS_END)
  if (start < 0 || end < start) throw new Error("organizer-ticketing-terms.html: terms markers not found")
  const body = html.slice(start + TERMS_START.length, end).trim()
  return { version, body, sha256: createHash("sha256").update(body, "utf8").digest("hex") }
}

/**
 * The terms as the server renders them now. Read on every call, never cached,
 * so the hash an acceptance records is of the text this deploy shows. Our own
 * file, never user input, which is what makes rendering its HTML safe.
 */
export function readOrganizerTicketingTerms(): ShownTerms {
  const html = readFileSync(path.join(process.cwd(), "docs/legal/organizer-ticketing-terms.html"), "utf8")
  return organizerTicketingTermsBody(html, ORGANIZER_TICKETING_TERMS.version)
}
