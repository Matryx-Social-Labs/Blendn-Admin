"use client"

import { useEffect, useState, useTransition } from "react"
import { IconBuilding, IconCircleCheck } from "@tabler/icons-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface Match {
  id: string
  name: string
  requestState: "pending" | "approved" | "declined" | null
}

/**
 * The requester's half of request-to-join.
 *
 * A user with no organisation used to hit "Contact support — this shouldn't
 * happen", which was a dead end sitting on top of a fully built approval flow.
 *
 * Only organisations that have verified this person's own email domain appear.
 * That is what makes the list safe to show: it is not a directory of every
 * company on Blend'n, it is the ones that proved they control the domain of the
 * address you signed in with.
 */
export function JoinRequest() {
  const [state, setState] = useState<{ domain: string | null; matches: Match[] } | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    fetch("/api/organisation/join-request")
      .then((r) => r.json())
      .then(setState)
      .catch(() => setState({ domain: null, matches: [] }))
  }, [])

  function ask(match: Match) {
    start(async () => {
      const res = await fetch("/api/organisation/join-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: match.id }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.error ?? "Could not send that request")
        return
      }
      toast.success(
        body.alreadyMember
          ? `You're already in ${match.name} — reload to see it.`
          : `Request sent to ${match.name}.`
      )
      setState((s) =>
        s
          ? {
              ...s,
              matches: s.matches.map((m) =>
                m.id === match.id ? { ...m, requestState: "pending" } : m
              ),
            }
          : s
      )
    })
  }

  if (!state) {
    return <p className="text-[0.8125rem] text-muted-foreground">Checking your email domain…</p>
  }

  if (state.matches.length === 0) {
    return (
      <EmptyState
        icon={<IconBuilding />}
        title="No organisation"
        description={
          state.domain
            ? `Your account isn't attached to an organisation, and no organisation has verified ${state.domain}. Ask a colleague to invite you, or apply to host at /apply.`
            : "Your account isn't attached to an organisation. Ask a colleague to invite you, or apply to host at /apply."
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-[length:var(--text-h2)] font-bold">Join your organisation</h2>
        <p className="text-[0.8125rem] leading-6 text-muted-foreground">
          These organisations have verified <b className="text-foreground">{state.domain}</b>, the
          domain of your email address. An admin there decides — approval gives you staff access,
          which you can be promoted from afterwards.
        </p>
      </div>

      {state.matches.map((match) => (
        <div
          key={match.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <span className="text-sm font-medium">{match.name}</span>
          {match.requestState === "pending" ? (
            <Badge variant="secondary" className="gap-1">
              <IconCircleCheck className="size-3.5" /> Requested — waiting on them
            </Badge>
          ) : match.requestState === "declined" ? (
            <span className="flex items-center gap-2">
              <Badge variant="outline">Declined</Badge>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => ask(match)}>
                Ask again
              </Button>
            </span>
          ) : (
            <Button size="sm" disabled={pending} onClick={() => ask(match)}>
              Ask to join
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
