import { connection } from "next/server"

import { COMPANY } from "@/lib/company"
import { adminSsoRequired, dashboardGoogleClient } from "@/lib/env"

import { SignInForm, type StaffGoogle } from "./sign-in-form"

/**
 * Where NextAuth sends a Google sign-in it did not finish (`pages.error` and `pages.signIn` in lib/auth.ts), said in
 * fixed words. The parameter itself is never rendered, and a code not listed here says nothing.
 */
const GOOGLE_ERRORS = new Map([
  ["AccessDenied", `That Google account isn't a Blend'n staff account. Use your @${COMPANY.staffEmailDomain} account.`],
  ["OAuthAccountNotLinked", "Another account is signed in in this browser. Open a private window and try again."],
  ["OAuthSignin", "Google sign-in didn't finish. Try again."],
  ["OAuthCallback", "Google sign-in didn't finish. Try again."],
  ["OAuthCreateAccount", "Google sign-in didn't finish. Try again."],
  ["Callback", "Google sign-in didn't finish. Try again."],
])

/**
 * Sign in. A server page only so that it reads the staff Google configuration when asked, not when the image was built
 * (`connection()`): one image runs on staging and production. The form is `./sign-in-form`.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  await connection()
  const staffGoogle: StaffGoogle = !dashboardGoogleClient() ? "off" : adminSsoRequired() ? "required" : "on"
  const { error } = await searchParams
  const googleError = staffGoogle !== "off" && typeof error === "string" ? (GOOGLE_ERRORS.get(error) ?? null) : null
  return <SignInForm staffGoogle={staffGoogle} googleError={googleError} />
}
