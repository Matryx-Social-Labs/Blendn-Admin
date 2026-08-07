"use client"

import Link from "next/link"
import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

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

  return (
    <Card className="apply-card w-full max-w-lg rounded-3xl">
      <CardContent className="space-y-5 px-8 py-10 text-center">
        {state === "working" ? (
          <p className="text-sm text-muted-foreground">Confirming your address...</p>
        ) : (
          <>
            {state === "ok" ? (
              <IconCircleCheck className="mx-auto size-12 text-primary" />
            ) : (
              <IconAlertTriangle className="mx-auto size-12 text-amber-500" />
            )}
            <h1 className="text-2xl font-bold text-foreground">
              {state === "ok" ? "Email confirmed" : "That link didn't work"}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">{message}</p>
            <Button asChild variant="outline" className="rounded-2xl">
              <Link href={state === "ok" ? "/" : "/apply"}>
                {state === "ok" ? "Back to Blend'n" : "Apply again"}
              </Link>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default function VerifyPage() {
  return (
    // Same funnel, same theme. The confirmation link is the last step before
    // approval, and letting it fall back to dark would break continuity at the
    // one moment someone is checking they did the right thing.
    <main className="apply-light apply-gradient flex min-h-screen items-center justify-center px-6 py-10">
      {/* useSearchParams needs a Suspense boundary or the whole route opts out
          of static rendering and the build warns. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
        <Verify />
      </Suspense>
    </main>
  )
}
