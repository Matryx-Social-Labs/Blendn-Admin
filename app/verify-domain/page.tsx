"use client"

import Link from "next/link"
import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Callout } from "@/components/dashboard/kit"
import { AuthFrame } from "@/components/public-frame"
import { Button } from "@/components/ui/button"

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

  if (state === "working") return <Working />

  return (
    <AuthFrame title={state === "ok" ? "Domain verified" : "That link didn't work"}>
      <Callout tone={state === "ok" ? "success" : "warning"} role="status">
        {message}
      </Callout>
      <Button asChild size="lg" variant={state === "ok" ? "default" : "outline"}>
        <Link href={state === "ok" ? "/dashboard/organisation" : "/"}>
          {state === "ok" ? "Go to the organisation" : "Back to Blend'n"}
        </Link>
      </Button>
    </AuthFrame>
  )
}

function Working() {
  return (
    <AuthFrame title="Confirming the domain…">
      <p className="text-[0.8125rem] text-muted-foreground">One moment.</p>
    </AuthFrame>
  )
}

export default function VerifyDomainPage() {
  return (
    // useSearchParams needs a Suspense boundary or the whole route opts out of
    // static rendering and the build warns.
    <Suspense fallback={<Working />}>
      <Verify />
    </Suspense>
  )
}
