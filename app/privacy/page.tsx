import { redirect } from "next/navigation"

import { COMPANY } from "@/lib/company"

/**
 * One privacy policy, the one the app links to: the landing site's (updated
 * 28 September 2026). `docs/legal/privacy-policy.html` is the March draft and
 * predates the 180-day retention it now has to state, so it is not served.
 */
export default function PrivacyPage() {
  redirect(COMPANY.privacyUrl)
}
