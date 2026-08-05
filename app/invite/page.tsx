"use client"

import Link from "next/link"
import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useSession } from "next-auth/react"
import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

/**
 * Landing page for an invite link.
 *
 * Accepting requires being signed in — an invite is permission to join a
 * company, not a way to create an account. Someone who is not signed in is sent
 * to /login with a callback back here, so the token survives the round trip.
 */

function Accept() {
  const token = useSearchParams().get("token")
  const { status } = useSession()
  const [state, setState] = useState<"working" | "ok" | "bad" | "signin">("working")
  const [message, setMessage] = useState("")
  const [roleChanged, setRoleChanged] = useState(false)

  useEffect(() => {
    if (status === "loading") return
    if (!token) {
      setState("bad")
      setMessage("This link is missing its token.")
      return
    }
    if (status === "unauthenticated") {
      setState("signin")
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/organisation/accept-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
        const body = await res.json()
        if (cancelled) return
        if (res.ok && body.success) {
          setState("ok")
          setRoleChanged(!!body.roleChanged)
          setMessage(
            body.alreadyMember
              ? `You're already part of ${body.orgName}.`
              : `You've joined ${body.orgName}.`
          )
        } else {
          setState(body.needsSignIn ? "signin" : "bad")
          setMessage(body.error ?? "This invite could not be accepted.")
        }
      } catch {
        if (!cancelled) {
          setState("bad")
          setMessage("Couldn't reach the server. Try again in a moment.")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, status])

  if (state === "working") {
    return <p className="text-sm text-muted-foreground">Checking your invite...</p>
  }

  if (state === "signin") {
    const callback = `/invite?token=${encodeURIComponent(token ?? "")}`
    return (
      <Card className="w-full max-w-lg rounded-xl shadow-none">
        <CardContent className="space-y-5 px-8 py-10 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Sign in to accept</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {message ||
              "Invites are tied to the email address they were sent to. Sign in with that address and you'll come straight back here."}
          </p>
          <Button asChild className="rounded-xl">
            <Link href={`/login?callbackUrl=${encodeURIComponent(callback)}`}>Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    )
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
          {state === "ok" ? "You're in" : "That invite didn't work"}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">{message}</p>
        {state === "ok" && roleChanged ? (
          <p className="text-sm leading-6 text-muted-foreground">
            Sign out and back in to pick up your new access.
          </p>
        ) : null}
        <Button asChild variant={state === "ok" ? "default" : "outline"} className="rounded-xl">
          <Link href={state === "ok" ? "/dashboard" : "/"}>
            {state === "ok" ? "Go to dashboard" : "Back to Blend'n"}
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}

export default function InvitePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
        <Accept />
      </Suspense>
    </main>
  )
}
