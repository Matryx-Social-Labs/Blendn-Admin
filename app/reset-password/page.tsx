"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { IconCircleCheck } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { checkPassword, MIN_PASSWORD_LENGTH } from "@/lib/password"

/**
 * Set a new password from a reset link.
 *
 * `checkPassword` is imported rather than reimplemented, so what this form says
 * and what the server enforces are the same function — a form that says "looks
 * good" over a server that returns 400 is the drift worth designing out.
 *
 * The token is read from `window.location` in an effect rather than through
 * `useSearchParams`, which would put the whole form behind a Suspense boundary
 * and flush the fallback into the server-rendered HTML.
 */
export default function ResetPasswordPage() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"))
  }, [])

  // Live, so the requirement is visible before submitting rather than after.
  const localCheck = password ? checkPassword(password) : null
  const mismatch = confirm.length > 0 && password !== confirm

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    const check = checkPassword(password)
    if (!check.ok) return setError(check.message ?? "Pick a stronger password.")
    if (password !== confirm) return setError("The two passwords don't match.")

    setLoading(true)
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? "Could not reset your password.")
        return
      }
      setDone(true)
      // Straight to sign-in rather than logging them in from here: proving they
      // can use the new password is the point of having set it.
      setTimeout(() => router.push("/login"), 2500)
    } catch {
      setError("Couldn't reach the server. Try again in a moment.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      <Image
        src="/brand/monogram-gradient.png"
        alt=""
        aria-hidden
        width={560}
        height={560}
        className="pointer-events-none absolute -bottom-[18%] -right-[8%] w-[560px] max-w-none opacity-[0.04]"
      />

      <div className="relative flex w-full max-w-[400px] flex-col gap-7">
        <div className="flex flex-col items-center gap-3.5">
          <Image src="/brand/monogram-gradient.png" alt="Blend'n" width={64} height={64} priority />
          <div className="text-center">
            <h1 className="text-[length:var(--text-h1)] font-bold">
              {done ? "Password changed" : "Set a new password"}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {done
                ? "Signing you back in…"
                : `At least ${MIN_PASSWORD_LENGTH} characters. Length beats symbols.`}
            </p>
          </div>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-4 rounded-[var(--radius)] border border-border bg-card p-6 text-center">
            <IconCircleCheck className="size-8 text-primary" />
            <p className="text-[0.8125rem] leading-6 text-muted-foreground">
              Any mobile app sessions on this account were signed out, in case someone else had
              them.
            </p>
            <Button asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="relative flex flex-col gap-4 overflow-hidden rounded-[var(--radius)] border border-border bg-card p-6"
          >
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-[3px] bg-[image:var(--gradient-brand)]"
            />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                className="h-11"
              />
              {localCheck && !localCheck.ok ? (
                <p className="text-[0.75rem] text-muted-foreground">{localCheck.message}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm">Confirm</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                aria-invalid={mismatch}
                className="h-11"
              />
              {mismatch ? (
                <p className="text-[0.75rem] text-destructive">These don&apos;t match.</p>
              ) : null}
            </div>

            {error ? (
              <p role="alert" className="text-[0.8125rem] text-destructive">
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              size="lg"
              disabled={loading || !token || !localCheck?.ok || mismatch}
              className="w-full"
            >
              {loading ? "Saving…" : "Change password"}
            </Button>

            {!token ? (
              <p className="text-[0.75rem] text-muted-foreground">
                This link is missing its token. Use the link from the email exactly as sent, or{" "}
                <Link href="/forgot-password" className="text-primary hover:underline">
                  request a new one
                </Link>
                .
              </p>
            ) : null}
          </form>
        )}
      </div>
    </main>
  )
}
