"use client"

import Image from "next/image"
import Link from "next/link"
import { useState } from "react"
import { IconArrowLeft, IconMailForward } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Ask for a reset link.
 *
 * The confirmation is deliberately the same whether or not the address has an
 * account. Telling someone "no account with that email" turns this form into an
 * account-enumeration oracle: feed it a list, learn who is a customer. The
 * server behaves identically; this screen just has to not undo that.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
    } catch {
      // Deliberately ignored. A network error must not render differently from
      // a success, or the difference is the oracle we just avoided.
    } finally {
      setSent(true)
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
              {sent ? "Check your email" : "Reset your password"}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {sent
                ? "If that address has an account, a reset link is on its way."
                : "We'll send a link to set a new one."}
            </p>
          </div>
        </div>

        {sent ? (
          <div className="flex flex-col items-center gap-4 rounded-[var(--radius)] border border-border bg-card p-6 text-center">
            <IconMailForward className="size-8 text-primary" />
            <p className="text-[0.8125rem] leading-6 text-muted-foreground">
              The link expires in an hour and works once. If nothing arrives, check spam — and
              remember the address has to match the one on your account exactly.
            </p>
            <Button asChild variant="outline">
              <Link href="/login">Back to sign in</Link>
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
            <Button type="submit" size="lg" disabled={loading} className="w-full">
              {loading ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}

        {!sent ? (
          <Link
            href="/login"
            className="mx-auto inline-flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground hover:text-foreground"
          >
            <IconArrowLeft className="size-3.5" /> Back to sign in
          </Link>
        ) : null}
      </div>
    </main>
  )
}
