"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { signIn, useSession } from "next-auth/react"

import { COMPANY, POLICY_LINKS, isStaffEmail } from "@/lib/company"
import { AuthFrame } from "@/components/public-frame"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { APP_ONLY_SIGNIN, SIGNIN_ACCOUNT_LOCKED, SIGNIN_RATE_LIMITED, canAccessDashboard } from "@/lib/rbac"
import { safeRedirect } from "@/lib/safe-redirect"

/** Staff Google sign-in here: not configured, offered, or the only way an admin gets in (`ADMIN_SSO_REQUIRED`). */
export type StaffGoogle = "off" | "on" | "required"

const NO_MATCH = "That email and password don't match an operator account."
const STAFF_GOOGLE = "Staff sign in with Google. Use the button below."

/**
 * What a refused password is told. One message for a wrong email and a wrong password: telling them apart confirms
 * which addresses have accounts. Under `ADMIN_SSO_REQUIRED` an admin's password is refused the same way, so a staff
 * address is pointed at Google; the staff domain is public, so that says nothing about the account.
 */
export function signinFailure(email: string, staffGoogle: StaffGoogle): string {
  return staffGoogle === "required" && isStaffEmail(email) ? STAFF_GOOGLE : NO_MATCH
}

/**
 * Sign in.
 *
 * The one screen where the gradient monogram carries the brand — everywhere
 * else the gradient is reserved for a single hero metric.
 *
 * This replaces a two-column marketing split: a hero lockup beside three
 * value-prop cards ("Performance reporting", "Role-aware insights",
 * "Exportable reporting"). That layout was selling the product to someone who
 * has already decided to use it. Everyone who reaches this page has an account
 * and wants to be past it, so the design is a single centred column and one
 * card.
 *
 * The "forgotten password" link was absent in the first import because there
 * was no reset flow and a 404 is worse than a missing link. There is one now.
 */
export function SignInForm({ staffGoogle, googleError }: { staffGoogle: StaffGoogle; googleError: string | null }) {
  const router = useRouter()
  const { status, data: session } = useSession()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<React.ReactNode>(null)

  /*
   * `/invite?token=…` sends people here and expects them back afterwards.
   *
   * Read from `window.location` rather than `useSearchParams`, which would
   * force this whole form behind a Suspense boundary — and a statically
   * rendered page flushes the *fallback*, so the initial HTML would be the word
   * "Loading" and the form would only appear after hydration. The callback is
   * not needed until submit, which is long after that.
   */
  const [callbackUrl, setCallbackUrl] = useState("/dashboard")
  useEffect(() => {
    setCallbackUrl(safeRedirect(new URLSearchParams(window.location.search).get("callbackUrl")))
  }, [])

  /*
   * Only a session the dashboard will take. A suspended operator's live cookie
   * is re-read as `attendee`, and pushing it to /dashboard only earned a
   * bounce back here (SCRUM-172).
   */
  const role = session?.user?.role
  useEffect(() => {
    if (status === "authenticated" && role && canAccessDashboard(role)) router.push(callbackUrl)
  }, [status, role, router, callbackUrl])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const result = await signIn("credentials", { email, password, redirect: false })
      /*
       * The sign-in route is rate limited per network, and NextAuth reports a
       * 429 as `ok: false` with no `error` string. This branch used to check
       * `error` alone, push to the dashboard, get bounced straight back to
       * /login by the middleware, and show nothing — a locked-out operator
       * saw the form reappear and typed the password again. Found by signing
       * in as four people in one afternoon.
       */
      if (result?.status === 429) {
        setError(RATE_LIMITED)
        return
      }
      // The password was right and the account is an attendee's: no session
      // was made, so say so instead of reappearing blank (SCRUM-172).
      if (result?.error === SIGNIN_ACCOUNT_LOCKED) {
        setError(ACCOUNT_LOCKED)
        return
      }
      if (result?.error === SIGNIN_RATE_LIMITED) {
        setError(RATE_LIMITED)
        return
      }
      if (result?.error === APP_ONLY_SIGNIN) {
        setError(APP_ONLY)
        return
      }
      if (result?.error || !result?.ok) {
        setError(signinFailure(email, staffGoogle))
        return
      }
      router.push(callbackUrl)
      router.refresh()
    } catch (err) {
      /*
       * next-auth's client does `new URL(data.url)` on whatever the callback
       * returned. The rate limiter answers 429 with a JSON body and no `url`,
       * so the client throws `TypeError: Invalid URL` before `status` is ever
       * returned — which is how a lockout read as "couldn't reach the server".
       * A real network failure throws too, with "Failed to fetch" / "Load
       * failed", so the message is the only thing that tells them apart.
       */
      const invalidUrl = err instanceof TypeError && /Invalid URL/i.test(err.message)
      setError(invalidUrl ? RATE_LIMITED : "Couldn't reach the server. Try again in a moment.")
    } finally {
      setLoading(false)
    }
  }

  /*
   * No loading gate.
   *
   * `useSession()` reports "loading" during server rendering — there is no
   * session to read yet — so returning early on it meant the server rendered
   * the word "Loading" and *nothing else*. The form only existed after
   * hydration, which is what `curl /login` showed and what a slow connection
   * got.
   *
   * Someone signed out should see the form immediately; someone already signed
   * in is moved along by the effect above. Neither case wants a spinner.
   */
  return (
    <AuthFrame
      title="Blend'n dashboard"
      sub="For the people who run the platform and the events on it."
      after={
        <>
          <p className="mx-auto max-w-[40ch] text-center text-[0.78125rem] text-faint-foreground">
            Operator access only — attendees use the Blend&apos;n app. Not a host yet?{" "}
            <Link href="/apply" className="underline underline-offset-4 hover:text-foreground">
              Apply
            </Link>
            .
          </p>
          {/* The public policy pages (components/policy-page.tsx), reachable signed out. */}
          <nav aria-label="Policies">
            <ul className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[0.75rem] text-faint-foreground">
              {POLICY_LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-foreground">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@venue.com"
            autoComplete="email"
            required
            className="h-11"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
            aria-invalid={!!error}
            aria-describedby={error ? "signin-error" : undefined}
            className="h-11"
          />
          {error ? (
            <p id="signin-error" role="alert" className="text-[0.8125rem] text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <Button type="submit" size="lg" disabled={loading} className="w-full">
          {loading ? "Signing in…" : "Sign in"}
        </Button>

        {/* Now a real destination. It was left out of the design import because
            there was no reset flow and a 404 is worse than an absent link. */}
        <Link
          href="/forgot-password"
          className="text-center text-[0.8125rem] text-muted-foreground hover:text-foreground"
        >
          Forgotten your password?
        </Link>

        {/* Platform staff, with the company Google account (SCRUM-1241). Only when the dashboard's client is set:
            unset, this card is exactly what it was. */}
        {staffGoogle === "off" ? null : (
          <div className="flex flex-col gap-2.5 border-t border-border pt-4">
            <p id="staff-google-label" className="text-center text-xs text-muted-foreground">
              {`Platform staff · @${COMPANY.staffEmailDomain}`}
            </p>
            {googleError ? (
              <p role="alert" className="text-center text-[0.8125rem] text-destructive">
                {googleError}
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={status === "loading"}
              aria-describedby="staff-google-label"
              onClick={() => signIn("google", { callbackUrl })}
              className="w-full whitespace-normal h-auto min-h-11 py-2"
            >
              <GoogleMark />
              Sign in with Google
            </Button>
          </div>
        )}
      </form>
    </AuthFrame>
  )
}

/** Google's "G", inline: the enforced CSP loads no image from Google, and the mark is decoration beside its label. */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className="size-[18px]">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

const APP_ONLY = (
  <>
    This account is for the Blend&apos;n app. The dashboard is for people who run events and
    venues &mdash;{" "}
    <Link href="/apply" className="underline">
      apply here
    </Link>
    .
  </>
)

const RATE_LIMITED =
  "Too many sign-in attempts from this network. Wait fifteen minutes and try again."

// Anyone can spend this against an address; the reset link is how its owner gets in at once.
const ACCOUNT_LOCKED =
  "Too many wrong passwords for this account. Use Forgot password to reset it and sign in now, or wait fifteen minutes."
