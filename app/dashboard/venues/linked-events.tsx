"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { IconAlertTriangle, IconCheck, IconLoader2, IconX } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/dashboard/primitives"
import { IconCalendar } from "@tabler/icons-react"
import { formatSince } from "@/lib/dashboard-format"
import {
  confirmVenueLink,
  disputeVenueLink,
  type VenueLinkedEvent,
} from "@/lib/venue-link-actions"

/**
 * Events other organisers are holding at your venue.
 *
 * This is where the reversibility promise finally has a control attached. Until
 * now an event could auto-link to a venue and hand its owner the chatroom, the
 * attendee count and the feedback, and the owner had no way to say "that is not
 * mine" — `venue_link_status: "disputed"` was written by nothing.
 *
 * Disputing does not detach the event. An owner who could unlink freely could
 * hide events they would rather not answer for, so it flags the link for an
 * admin instead. Detaching is the organiser's call.
 */
export function LinkedEvents({ events }: { events: VenueLinkedEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={<IconCalendar />}
        title="No events linked yet"
        description="When an organiser picks one of your venues, their event appears here — and so do its chatroom and attendee count. You can dispute anything that is not actually yours."
      />
    )
  }

  const disputed = events.filter((e) => e.linkStatus === "disputed").length

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[length:var(--text-h2)] font-bold">Events at your venues</h2>
        {disputed > 0 ? (
          <p className="text-[0.78125rem] text-warning">
            {disputed} disputed, waiting on an admin
          </p>
        ) : null}
      </div>
      <p className="max-w-prose text-[0.8125rem] text-muted-foreground">
        You see the chatroom, attendee count and feedback for each of these. If one is not
        actually at your venue, dispute it — an admin resolves it and the organiser is told.
      </p>

      <ul className="flex flex-col gap-2">
        {events.map((event) => (
          <LinkedEventRow key={event.id} event={event} />
        ))}
      </ul>
    </section>
  )
}

function LinkedEventRow({ event }: { event: VenueLinkedEvent }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [disputing, setDisputing] = useState(false)
  const [reason, setReason] = useState("")

  function act(fn: () => Promise<void>, ok: string) {
    startTransition(async () => {
      try {
        await fn()
        toast.success(ok)
        setDisputing(false)
        setReason("")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "That did not work.")
      }
    })
  }

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Link
            href={`/dashboard/events/${event.id}`}
            className="text-[0.875rem] font-bold underline-offset-4 hover:underline"
          >
            {event.title}
          </Link>
          <p className="text-[0.75rem] text-faint-foreground">
            {event.venueName} · {formatSince(event.startAt)} ·{" "}
            {event.organiserName ?? "Unknown organiser"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {event.linkStatus === "disputed" ? (
            <Badge variant="destructive">Disputed</Badge>
          ) : event.linkStatus === "confirmed" ? (
            <Badge variant="secondary">
              <IconCheck className="size-3" />
              Confirmed
            </Badge>
          ) : (
            <Badge>Auto-linked</Badge>
          )}
        </div>
      </div>

      {disputing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this not at your venue? An admin reads this."
            rows={2}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDisputing(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending || reason.trim().length < 10}
              onClick={() => act(() => disputeVenueLink(event.id, reason), "Dispute filed.")}
            >
              {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
              File dispute
            </Button>
          </div>
        </div>
      ) : event.linkStatus !== "disputed" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {event.linkStatus !== "confirmed" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => act(() => confirmVenueLink(event.id), "Confirmed.")}
            >
              <IconCheck className="size-3.5" />
              That&rsquo;s mine
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => setDisputing(true)}>
            <IconX className="size-3.5" />
            Not at my venue
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-[0.75rem] text-muted-foreground">
          <IconAlertTriangle className="size-3.5 text-warning" />
          An admin is reviewing this. You still see the event until it is resolved.
        </p>
      )}
    </li>
  )
}
