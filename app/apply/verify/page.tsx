"use client"

import Link from "next/link"
import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Callout } from "@/components/dashboard/kit"
import { PublicFrame, PublicLockup } from "@/components/public-frame"
import { Button } from "@/components/ui/button"

/**
 * Confirming the email address on an application.
 *
 * The token arrives in the query string and is POSTed once — a GET that
 * consumed it would be spent by any mail client that prefetches links, and the
 * applicant would land on "already used" without ever clicking.
 */

function Verify() {
  const token = useSearchParams().get("token")
  const [state, setState] = useState<"working" | "ok" | "bad">("working")
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!token) {
      setState("bad")
      setMessage("This link is missing its token. Use the link from the email exactly as sent.")
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/onboarding/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
        const body = await res.json()
        if (cancelled) return
        if (res.ok && body.success) {
          setState("ok")
          setMessage(
            body.alreadyVerified
              ? "This address is already confirmed. Your application is with our team."
              : "Thanks — your address is confirmed. Our team will review your application and email you, usually within two working days."
          )
        } else {
          setState("bad")
          setMessage(body.error ?? "This link is invalid or has expired.")
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

  if (state === "working") return <Confirming />

  return (
    <Shell title={state === "ok" ? "Email confirmed" : "That link didn't work"}>
      <Callout tone={state === "ok" ? "success" : "warning"} role="status">
        {message}
      </Callout>
      <Button asChild variant="outline" className="w-fit rounded-2xl">
        <Link href={state === "ok" ? "/" : "/apply"}>{state === "ok" ? "Back to Blend'n" : "Apply again"}</Link>
      </Button>
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <PublicFrame width="narrow">
      <div className="flex flex-col gap-5 px-8 py-10">
        <PublicLockup />
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        {children}
      </div>
    </PublicFrame>
  )
}

function Confirming() {
  return (
    <Shell title="Confirming your address…">
      <p className="text-sm text-muted-foreground">One moment.</p>
    </Shell>
  )
}

export default function VerifyPage() {
  return (
    // Same funnel, same theme (PublicFrame): the confirmation link is the last
    // step before approval, and a dark page here would break continuity at the
    // one moment someone is checking they did the right thing.
    // useSearchParams needs a Suspense boundary or the whole route opts out of
    // static rendering and the build warns.
    <Suspense fallback={<Confirming />}>
      <Verify />
    </Suspense>
  )
}
