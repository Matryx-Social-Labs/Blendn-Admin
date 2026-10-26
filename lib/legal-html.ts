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
