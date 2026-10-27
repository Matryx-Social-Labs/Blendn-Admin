import { readFileSync } from "node:fs"
import path from "node:path"
import type { Metadata } from "next"

import { PolicyPage } from "@/components/policy-page"
import { termsBody } from "@/lib/legal-html"

export const metadata: Metadata = { title: "Terms of Use" }

/**
 * The Terms of Use, from `docs/legal/terms-of-use.html` — the one copy; edit
 * that file, not this page. Read at build time (the page is static), so the
 * deployed text is the committed text. Our own file, never user input, which
 * is what makes the raw HTML safe to render.
 */
export default function TermsPage() {
  const html = readFileSync(path.join(process.cwd(), "docs/legal/terms-of-use.html"), "utf8")
  const { updated, body } = termsBody(html)
  return (
    <PolicyPage path="/terms" title="Terms of Use" updated={updated}>
      <div dangerouslySetInnerHTML={{ __html: body }} />
    </PolicyPage>
  )
}
