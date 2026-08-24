import { notFound } from "next/navigation"
import { IconExternalLink } from "@tabler/icons-react"

import { Card } from "@/components/ui/card"
import { getAuth } from "@/lib/auth"
import { claimRefusal, curationSelect } from "@/lib/curation"
import { db } from "@/lib/db"
import { owningOrgFor } from "@/lib/event-ownership"

import { ClaimForm } from "./claim-form"

export const dynamic = "force-dynamic"

/**
 * "This event is mine."
 *
 * The entry to the acquisition funnel, and the reason it exists as its own
 * public route: the eng review found `fileEventClaim` with **zero callers** and
 * no page anywhere that files a claim. The admin half of W5 was complete and
 * the queue it reads could never fill. The venue queue has had a filing page
 * since it shipped (`app/dashboard/venues/[id]/claim/page.tsx`); the event
 * queue did not.
 *
 * ## Public, on purpose
 *
 * `middleware.ts` matches `/`, `/login`, `/dashboard/*` and `/api/mobile/*`.
 * `/claim/*` is deliberately none of them, because the person this page is for
 * has no account — that is *why* their event was curated rather than filed.
 * Putting a sign-in in front of it would be a signup wall in front of the
 * signup funnel.
 *
 * ## What it does not do
 *
 * It does not decide anything. Filing costs nothing and grants nothing: an
 * admin reads the flags and decides, and until then the event is exactly as it
 * was. That asymmetry is what makes an unauthenticated write defensible here
 * and would not make one defensible on the approve path.
 */
export default async function ClaimEventPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params

  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      title: true,
      venue_name: true,
      city: true,
      source_url: true,
      timezone: true,
      ...curationSelect,
    },
  })
  if (!event) notFound()

  /*
   * The same resolver the write path calls, so the page and the submit cannot
   * disagree. A form that renders and then refuses is the exact divergence W4
   * spent a workstream removing from the chat endpoints.
   */
  const refusal = claimRefusal(event)

  /*
   * Whether they already have an organisation decides which half of the form
   * they see -- and it is resolved here, from the session, never from anything
   * the browser sends. `fileEventClaim` resolves it again the same way; this
   * copy only chooses what to render.
   */
  const session = await getAuth()
  let hasOrg = false
  if (session?.user && session.user.role !== "app_admin") {
    try {
      hasOrg = (await owningOrgFor(session.user)) !== null
    } catch {
      hasOrg = false
    }
  }

  const when = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: event.timezone,
  }).format(event.start_time)

  return (
    <main className="flex min-h-screen items-start justify-center px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-tight">Is this your event?</h1>
          <p className="text-[0.875rem] leading-6 text-muted-foreground">
            We added this listing from a public source so people in {event.city ?? "the city"} could
            find it. If you run it, take it over — you get the attendee list, the room, and every
            organiser screen.
          </p>
        </div>

        <Card className="flex flex-col gap-2 rounded-xl p-5">
          <h2 className="text-base font-bold">{event.title}</h2>
          <p className="text-[0.8125rem] text-muted-foreground">
            {[event.venue_name, event.city].filter(Boolean).join(" · ")}
          </p>
          <p className="text-[0.8125rem] tabular-nums text-muted-foreground">{when}</p>
          {event.source_url ? (
            <a
              href={event.source_url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex w-fit items-center gap-1.5 text-[0.8125rem] text-muted-foreground hover:text-foreground"
            >
              Where we found it
              <IconExternalLink className="size-3.5" />
            </a>
          ) : null}
        </Card>

        {refusal ? (
          /*
           * A refusal, phrased as a fact about the event rather than as an
           * error about the person. All three are states somebody honest can
           * arrive in, and two of them resolve on their own.
           */
          <Card className="flex flex-col gap-2 rounded-xl p-5">
            <p className="text-[0.875rem] font-medium">
              {refusal === "not_curated"
                ? "This one already has an organiser."
                : refusal === "already_claimed"
                  ? "This one has already been claimed."
                  : "This event is running right now."}
            </p>
            <p className="text-[0.8125rem] leading-6 text-muted-foreground">
              {refusal === "not_curated"
                ? "It was filed by whoever runs it, so there is nothing to hand over. If you think that is wrong, reply to us at the address on the listing."
                : refusal === "already_claimed"
                  ? "Somebody proved it was theirs and we handed it over. If that was not you and it should have been, get in touch."
                  : "Claims reopen once the room closes. We will not hand over an attendee list for people who are physically in a building right now — come back after it ends."}
            </p>
          </Card>
        ) : (
          <ClaimForm eventId={event.id} hasOrg={hasOrg} />
        )}
      </div>
    </main>
  )
}
