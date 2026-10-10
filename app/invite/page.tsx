"use client"

import Link from "next/link"
import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useSession } from "next-auth/react"
import type { org_role } from "@prisma/client"

import { Callout, Facts } from "@/components/dashboard/kit"
import { AuthFrame } from "@/components/public-frame"
import { Button } from "@/components/ui/button"
import { ROLE_BLURB, ROLE_LABEL } from "@/lib/org-roles"

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
  /** What they joined as, once the server says: the role in words (the kit's Invite). */
  const [joined, setJoined] = useState<{ org: string; role: org_role | null } | null>(null)

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
          setJoined({ org: body.orgName, role: body.role in ROLE_LABEL ? (body.role as org_role) : null })
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
    return (
      <AuthFrame title="Checking your invite…">
        <p className="text-[0.8125rem] text-muted-foreground">One moment.</p>
      </AuthFrame>
    )
  }

  if (state === "signin") {
    const callback = `/invite?token=${encodeURIComponent(token ?? "")}`
    return (
      <AuthFrame
        title="Sign in to accept"
        sub="An invite is permission to join an organisation, not a new account."
        after={<InviteNote />}
      >
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          {message ||
            "Invites are tied to the email address they were sent to. Sign in with that address and you'll come straight back here."}
        </p>
        <Button asChild size="lg">
          <Link href={`/login?callbackUrl=${encodeURIComponent(callback)}`}>Sign in</Link>
        </Button>
      </AuthFrame>
    )
  }

  if (state === "ok") {
    return (
      <AuthFrame title="You're in" sub={message}>
        {joined ? (
          <Facts
            cols={1}
            items={[
              { label: "Organisation", value: joined.org },
              joined.role ? { label: "Your role", value: `${ROLE_LABEL[joined.role]} — ${ROLE_BLURB[joined.role]}` } : null,
            ]}
          />
        ) : null}
        {roleChanged ? (
          <Callout tone="warning">Sign out and back in to pick up your new access.</Callout>
        ) : null}
        <Button asChild size="lg">
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title="That invite didn't work" after={<InviteNote />}>
      <Callout tone="warning">{message}</Callout>
      <Button asChild variant="outline" size="lg">
        <Link href="/">Back to Blend&apos;n</Link>
      </Button>
    </AuthFrame>
  )
}

function InviteNote() {
  return (
    <p className="text-center text-[0.78125rem] text-faint-foreground">
      Signed in with a different account? Sign out first — invites are tied to the address they were sent to.
    </p>
  )
}

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <AuthFrame title="Checking your invite…">
          <p className="text-[0.8125rem] text-muted-foreground">One moment.</p>
        </AuthFrame>
      }
    >
      <Accept />
    </Suspense>
  )
}
