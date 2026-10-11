"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { IconMicrophone2, IconSpeakerphone } from "@tabler/icons-react"

import { DecideBox } from "@/components/dashboard/decide-box"
import { Callout, Panel } from "@/components/dashboard/kit"
import { EmptyState } from "@/components/dashboard/primitives"
import { decideCreative, type CreativeQueueRow } from "@/lib/creative-review-actions"
import { formatDay } from "@/lib/dashboard-format"
import { refusalMessage } from "@/lib/refusal"

/**
 * Sponsored copy awaiting review, one bordered card per revision.
 *
 * The copy is shown as the room draws it, because that is what is being
 * approved: the megaphone and "Sponsored" in place of the author, the brand
 * beside it, the words under. The server's "📣 [Sponsored]" line is not drawn —
 * the dashboard's room feed drops it for the same badge (`chat-feed.tsx`), and
 * reading it here as text was reviewing something no room shows.
 */
export function CreativeQueue({ rows }: { rows: CreativeQueueRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<IconMicrophone2 />}
        title="Nothing waiting"
        description="Sponsored copy cannot run until it is read by a person. Every new campaign and every edit to an existing one arrives here first."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3.5">
      {rows.map((row) => (
        <CreativeCard key={row.id} row={row} />
      ))}
    </div>
  )
}

function CreativeCard({ row }: { row: CreativeQueueRow }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const brand = row.brandName ?? "No brand"

  function decide(decision: "approve" | "reject", note?: string) {
    startTransition(async () => {
      try {
        await decideCreative(row.id, decision, note)
        toast.success(
          decision === "approve"
            ? "Approved — the organiser can switch it on."
            : "Rejected. The campaign is stopped and the reason goes to the organiser."
        )
        router.refresh()
      } catch (e) {
        toast.error(refusalMessage(e, "Could not record the decision."))
      }
    })
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem] text-muted-foreground">
            <h2 className="text-[0.9375rem] font-bold text-foreground">{brand}</h2>
            {row.campaignActive ? (
              /*
                Live means this campaign is sending an EARLIER approved revision
                right now. Rejecting stops it; approving swaps what runs. Either
                way it is not a quiet decision — so it is the one word in colour.
              */
              <span className="font-bold text-destructive">· campaign is live</span>
            ) : null}
            {row.isLatest ? null : <span>· superseded</span>}
            {row.hadRejection ? <span>· refused before</span> : null}
          </div>
          <p className="text-[0.8125rem] text-muted-foreground">
            {row.ownerName ?? "Unclaimed brand"} ·{" "}
            <Link href={`/dashboard/events/${row.eventId}`} className="underline-offset-4 hover:underline">
              {row.eventTitle}
            </Link>{" "}
            · {formatDay(row.eventStart.toISOString())}
          </p>
        </div>
        <p className="text-[0.75rem] text-faint-foreground">Submitted {formatDay(row.createdAt.toISOString())}</p>
      </div>

      {/* As the room will render it. */}
      <figure className="flex max-w-[520px] flex-col gap-1.5 rounded-[10px] border border-chart-3/40 bg-chart-3/12 px-3.5 py-3">
        <figcaption className="inline-flex items-center gap-1.5 text-[0.71875rem] font-bold uppercase tracking-[0.06em] text-muted-foreground">
          <IconSpeakerphone aria-hidden className="size-3.5" />
          Sponsored · {brand}
        </figcaption>
        <p className="whitespace-pre-wrap break-words text-[0.875rem] leading-[22px]">{row.content}</p>
      </figure>
      <p className="text-[0.75rem] text-faint-foreground">
        As it will appear in the room
        {row.mediaUrl ? (
          <>
            {" "}
            · media{row.mediaType ? ` (${row.mediaType})` : ""}:{" "}
            <a href={row.mediaUrl} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-4">
              {row.mediaUrl}
            </a>
          </>
        ) : null}
      </p>

      {row.isLatest ? null : (
        <Callout>
          A newer revision of this campaign exists. Deciding this one records the verdict but does not change what
          runs.
        </Callout>
      )}

      <div className="border-t border-border pt-3.5">
        <DecideBox
          approveLabel="Approve"
          declineLabel="Reject"
          sendLabel="Send rejection"
          reasonLabel={`What has to change in ${brand}'s copy`}
          placeholder="What has to change — it is sent to the organiser, and a refusal with no reason comes back word for word."
          pending={pending}
          /* What the two buttons actually do, which is not what they say:
             neither starts a campaign, and one stops a running one. Beside the
             buttons, where the decision is made, not above the queue. */
          hint="Approve lets the organiser switch it on · Reject stops it now"
          onApprove={() => decide("approve")}
          onDecline={(reason) => decide("reject", reason)}
        />
      </div>
    </Panel>
  )
}
