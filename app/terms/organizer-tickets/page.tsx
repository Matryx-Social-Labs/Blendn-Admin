import type { Metadata } from "next"

import { PolicyPage } from "@/components/policy-page"
import { readOrganizerTicketingTerms } from "@/lib/legal-html"

// A draft: not for search engines until the lawyer signs it off.
export const metadata: Metadata = { title: "Organizer Ticketing Terms (draft)", robots: { index: false, follow: false } }

/**
 * The Organizer Ticketing Terms, from `docs/legal/organizer-ticketing-terms.html`
 * (the one copy; edit that file and bump the version in lib/legal-acceptance.ts).
 * The same body, byte for byte, as the Tickets tab's scroll panel, so "open the
 * full terms" shows the words whose hash an acceptance records. Our own file,
 * never user input, which is what makes the raw HTML safe to render.
 */
export default function OrganizerTicketingTermsPage() {
  const terms = readOrganizerTicketingTerms()
  return (
    <PolicyPage path="/terms" title="Organizer Ticketing Terms" updated="2 November 2026" lede={<span>Version {terms.version}</span>}>
      <div dangerouslySetInnerHTML={{ __html: terms.body }} />
    </PolicyPage>
  )
}
