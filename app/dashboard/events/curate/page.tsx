import { redirect } from "next/navigation"
import Link from "next/link"
import { IconExternalLink, IconMapPinOff } from "@tabler/icons-react"

import { EmptyState, MetricTile } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { getAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"

import { CurateForm } from "./curate-form"
import { CURATION_PAGE } from "@/lib/curation"
import { getCurationQueue } from "./queue-actions"

export const dynamic = "force-dynamic"

/**
 * Is what we added actually check-in-able?
 *
 * ## The one number this screen exists for
 *
 * **Curated events that ended with zero check-ins.** It is the only figure that
 * catches a wrong pin, a wrong time or a dead listing — all three produce
 * identical silence — and nothing else measures it.
 *
 * What separates them is whether anybody *tried*, which is why
 * `check_in_refusals` had to exist first. Zero check-ins and zero refusals is a
 * listing nobody wanted. Zero check-ins and eleven refusals is a pin in the
 * wrong place.
 *
 * ## One HeroMetric, and this is not it
 *
 * `DESIGN_SYSTEM.md` allows exactly one gradient-carrying `HeroMetric` per
 * screen, and this screen's most important figure is a *failure* count —
 * putting the brand gradient behind "3 dead listings" would be celebrating it.
 * `MetricTile` has no card chrome and lets type do the hierarchy, which is the
 * same rule.
 */
export default async function CuratePage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string }>
}) {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "app_admin") redirect("/dashboard")

  const { city } = await searchParams
  const { rows, total } = await getCurationQueue(city)

  const ended = rows.filter((r) => r.ended)
  const dead = ended.filter((r) => r.checkedIn === 0)
  const misPinned = dead.filter((r) => r.refused > 0)
  const claimed = rows.filter((r) => r.claimed).length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-bold">
          Curation health{city ? <span className="font-normal text-muted-foreground"> · {city}</span> : null}
        </h2>
        {/* The header already names the number that matters. What it cannot fit
            is how to read it, which is the only thing this line adds. */}
        <p className="max-w-2xl text-[0.8125rem] leading-6 text-muted-foreground">
          Whether anybody tried is the difference between a wrong pin and a dead
          listing.
        </p>
      </div>

      {/* Container queries, per DESIGN_SYSTEM.md: the sidebar is collapsible, so
          viewport breakpoints reflow out of step with the rest of the grid. */}
      {/*
        * Actionable first, vanity last.
        *
        * This led with "Curated", a count that only goes up and prompts nothing.
        * DESIGN_SYSTEM.md's central correction is that the forward-looking
        * question comes before any trailing report, and the forward-looking
        * question here is "which pin do I have to move today".
        */}
      <div className="grid grid-cols-2 gap-4 @2xl/main:grid-cols-4">
        <MetricTile
          label="Likely a wrong pin"
          value={misPinned.length}
          hint={misPinned.length > 0 ? "people tried and were refused" : "no refusals recorded"}
        />
        <MetricTile
          label="Ended with nobody in"
          value={dead.length}
          hint={ended.length > 0 ? `of ${ended.length} finished` : "none finished yet"}
        />
        <MetricTile label="Claimed" value={claimed} hint="handed to a real organiser" />
        <MetricTile label="Curated" value={total} />
      </div>

      {/*
        * The form sits above the queue, not behind a button.
        *
        * This screen is reached from a city row on the admin overview that says
        * people are waiting there — so the reason somebody is here is to add
        * one, and a screen that answers "how is curation going" without
        * offering "add another" is the read surface and the write surface on
        * different pages again. That is exactly how `city_demand` came to be
        * written for months and read never.
        */}
      <CurateForm defaultCity={city} />

      {rows.length === 0 ? (
        <EmptyState
          icon={<IconMapPinOff className="size-5" />}
          title={city ? `Nothing curated in ${city} yet` : "Nothing curated yet"}
          description={
            city
              ? "People are looking here and there is nothing to show them. Adding one event is the whole intervention."
              : "Curated events appear here with their check-in health, so a wrong pin surfaces before somebody complains."
          }
        />
      ) : (
        <>
          {total > rows.length ? (
            /*
             * A capped list that does not say so reads as "this is all of
             * them". Newest first, so the cap drops the oldest -- which for
             * curation health is the ones most likely to have finished and
             * failed.
             */
            <p className="text-[0.75rem] text-muted-foreground">
              Showing the {CURATION_PAGE} most recent of {total}. Filter by city
              to narrow it.
            </p>
          ) : null}
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            /*
             * Three states, and they read differently.
             *
             * A pin that turned people away is the actionable one — somebody
             * stood outside and could not get in. A listing nobody tried is a
             * different problem and a much less urgent one.
             */
            const wrongPin = row.ended && row.checkedIn === 0 && row.refused > 0
            const deadListing = row.ended && row.checkedIn === 0 && row.refused === 0
            return (
              <li
                key={row.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border px-4 py-3",
                  wrongPin ? "border-destructive/40 bg-destructive/5" : "border-border bg-card"
                )}
              >
                <Link
                  href={`/dashboard/events/${row.id}`}
                  /*
                   * `min-w-0` let the title shrink to nothing instead of
                   * wrapping the row. With `flex-wrap`, a sibling only moves to
                   * the next line when it cannot fit -- and a `flex-1` item that
                   * may shrink to zero always "fits", so at 375px the metadata
                   * held its width and a long title rendered one word per line
                   * down nine rows. A floor is what makes `flex-wrap` do its
                   * job; no breakpoint, because the trigger is the title's
                   * length, not the viewport's.
                   */
                  className="min-w-[14rem] flex-1 text-sm font-medium hover:underline"
                >
                  {row.title}
                </Link>
                {row.city ? (
                  <span className="text-[0.75rem] text-muted-foreground">{row.city}</span>
                ) : null}

                <span className="text-[0.75rem] tabular-nums text-muted-foreground">
                  {row.checkedIn} in
                </span>
                {row.refused > 0 ? (
                  <span
                    className="text-[0.75rem] tabular-nums text-destructive"
                    title={
                      row.medianShortfall !== null
                        ? `Median ${row.medianShortfall}m outside — a tight cluster is one street, a wide spread is a fence too tight`
                        : undefined
                    }
                  >
                    {row.refused} turned away
                    {row.medianShortfall !== null ? ` · ~${row.medianShortfall}m out` : ""}
                  </span>
                ) : null}

                {wrongPin ? (
                  <Badge variant="destructive" className="text-[0.6875rem]">
                    re-pin
                  </Badge>
                ) : deadListing ? (
                  <Badge variant="secondary" className="text-[0.6875rem]">
                    nobody came
                  </Badge>
                ) : null}
                {row.claimed ? (
                  <Badge variant="secondary" className="text-[0.6875rem]">
                    claimed
                  </Badge>
                ) : row.claims > 0 ? (
                  <Link href="/dashboard/claims" className="text-[0.75rem] hover:underline">
                    {row.claims} claim{row.claims === 1 ? "" : "s"}
                  </Link>
                ) : null}

                {row.sourceUrl ? (
                  <a
                    href={row.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground hover:text-foreground"
                  >
                    source <IconExternalLink className="size-3.5" />
                  </a>
                ) : null}

                {/*
                  The link an admin sends the real organiser.

                  Curation is only half a funnel without it: `/claim/<id>` is
                  public and session-free precisely so somebody with no account
                  can use it, and cold outreach is how most of them will hear
                  about it. Hidden once claimed, because then it refuses anyway
                  and offering it would be a dead end with a button on it.
                */}
                {!row.claimed ? (
                  <Link
                    href={`/claim/${row.id}`}
                    target="_blank"
                    className="text-[0.75rem] text-muted-foreground hover:text-foreground"
                  >
                    claim link
                  </Link>
                ) : null}
              </li>
            )
          })}
        </ul>
        </>
      )}
    </div>
  )
}
