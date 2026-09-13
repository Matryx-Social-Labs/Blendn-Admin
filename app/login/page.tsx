"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { signIn, useSession } from "next-auth/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { safeRedirect } from "@/lib/safe-redirect"

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
function SignInForm() {
  const router = useRouter()
  const { status } = useSession()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  useEffect(() => {
    if (status === "authenticated") router.push(callbackUrl)
  }, [status, router, callbackUrl])

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
      if (result?.error || !result?.ok) {
        // One message for a wrong email and a wrong password. Distinguishing
        // them confirms which addresses have accounts.
        setError("That email and password don't match an operator account.")
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
    <div className="relative flex w-full max-w-[400px] flex-col gap-7">
      <div className="flex flex-col items-center gap-3.5">
        <Image src="/brand/monogram-gradient.png" alt="Blend'n" width={64} height={64} priority />
        <div className="text-center">
          <h1 className="text-[length:var(--text-h1)] font-bold">Blend&apos;n dashboard</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            For the people who run the platform and the events on it.
          </p>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="relative flex flex-col gap-4 overflow-hidden rounded-[var(--radius)] border border-border bg-card p-6"
      >
        {/* The brand gradient, on the one screen it belongs to. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[3px] bg-[image:var(--gradient-brand)]"
        />

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
      </form>

      <p className="mx-auto max-w-[40ch] text-center text-[0.78125rem] text-faint-foreground">
        Operator access only — attendees use the Blend&apos;n app. Your role decides what you see
        after signing in.
      </p>
    </div>
  )
}

const RATE_LIMITED =
  "Too many sign-in attempts from this network. Wait fifteen minutes and try again."

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      {/* Oversized, barely-there monogram. Decorative, so it is hidden from
          assistive tech and cannot be clicked through to. */}
      <Image
        src="/brand/monogram-gradient.png"
        alt=""
        aria-hidden
        width={560}
        height={560}
        className="pointer-events-none absolute -bottom-[18%] -right-[8%] w-[560px] max-w-none opacity-[0.04]"
      />
      <SignInForm />
    </main>
  )
}
