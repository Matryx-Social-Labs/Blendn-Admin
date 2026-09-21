"use client"

import Link from "next/link"
import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Landing page for the link sent to a domain's role address.
 *
 * No sign-in: the person who reads `postmaster@acme.com` is usually not the
 * person who started the claim and often has no account. The token is POSTed
 * once from an effect — a GET that consumed it would be spent by any mail
 * client that prefetches links (see `app/api/org/domains/verify`).
 */
function Verify() {
  const token = useSearchParams().get("token")
  const [state, setState] = useState<"working" | "ok" | "bad">(token ? "working" : "bad")
  const [message, setMessage] = useState(
    token ? "" : "This link is missing its token. Use the link from the email exactly as sent."
  )

  useEffect(() => {
    if (!token) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/org/domains/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
        const body = await res.json()
        if (cancelled) return
        if (res.ok && body.success) {
          setState("ok")
          setMessage(
            `${body.domain} is verified. Colleagues with an address there can now ask to join, and invites to them go without ceremony.`
          )
        } else {
          setState("bad")
          setMessage(body.error ?? "This link is invalid or has expired. Ask for a new one.")
        }
      } catch {
        if (!cancelled) {
          setState("bad")
          setMessage("Couldn't reach the server. Try the link again in a moment.")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  if (state === "working") {
    return <p className="text-sm text-muted-foreground">Confirming the domain...</p>
  }

  return (
    <Card className="w-full max-w-lg rounded-xl shadow-none">
      <CardContent className="space-y-5 px-8 py-10 text-center">
        {state === "ok" ? (
          <IconCircleCheck className="mx-auto size-12 text-primary" />
        ) : (
          <IconAlertTriangle className="mx-auto size-12 text-amber-500" />
        )}
        <h1 className="text-2xl font-semibold text-foreground">
          {state === "ok" ? "Domain verified" : "That link didn't work"}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">{message}</p>
        <Button asChild variant={state === "ok" ? "default" : "outline"} className="rounded-xl">
          <Link href={state === "ok" ? "/dashboard/organisation" : "/"}>
            {state === "ok" ? "Go to the organisation" : "Back to Blend'n"}
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}

export default function VerifyDomainPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      {/* useSearchParams needs a Suspense boundary or the whole route opts out
          of static rendering and the build warns. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
        <Verify />
      </Suspense>
    </main>
  )
}
