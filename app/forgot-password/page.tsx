"use client"

import Link from "next/link"
import { useState } from "react"
import { IconArrowLeft } from "@tabler/icons-react"

import { Callout } from "@/components/dashboard/kit"
import { AuthFrame } from "@/components/public-frame"
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
    <AuthFrame
      title={sent ? "Check your email" : "Forgotten your password?"}
      sub={sent ? "If that address has an account, a reset link is on its way." : "We'll email a link to set a new one."}
      after={
        <Link
          href="/login"
          className="mx-auto inline-flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground hover:text-foreground"
        >
          <IconArrowLeft aria-hidden className="size-3.5" /> Back to sign in
        </Link>
      }
    >
      {sent ? (
        // The same words whether or not the address has an account (see above).
        <Callout tone="success" role="status">
          The link works once and expires in an hour. If nothing arrives, check spam — and the address
          has to match the one on your account exactly.
        </Callout>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Work email</Label>
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
    </AuthFrame>
  )
}
