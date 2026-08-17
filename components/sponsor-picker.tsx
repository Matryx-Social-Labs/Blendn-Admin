"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { IconExternalLink, IconSearch } from "@tabler/icons-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  attachSponsorToEvent,
  createUnclaimedSponsor,
  findSponsors,
  type SponsorMatch,
} from "@/lib/sponsor-actions"

/**
 * Attach a brand to an event.
 *
 * ## Why every row shows an owner and a placement count
 *
 * Picking the wrong "Red Bull" attaches this event to another company's report.
 * The name alone cannot distinguish them — the website and who owns the row can,
 * so both come back with the search rather than being fetched on hover.
 *
 * ## Why "Add new" is last and asks twice
 *
 * The duplicate problem is created here. An organiser who types past an existing
 * brand makes a second row that an admin has to merge later, and merges are
 * lossy work nobody enjoys. So the existing matches come first, and creating is
 * a second deliberate act when anything at all matched.
 *
 * ## Combobox semantics
 *
 * `role="combobox"` with `aria-expanded`, arrow keys to move, Enter to pick,
 * Escape to close. "Add new" is never the initially highlighted option — the
 * default action on a list of real brands should not be "ignore all of them".
 */
export function SponsorPicker({
  eventId,
  onAttached,
}: {
  eventId: string
  onAttached?: () => void
}) {
  const [query, setQuery] = useState("")
  /*
   * Results carry the query they answer. Rendering trusts them only while that
   * tag still matches the input, so a stale response can never be displayed
   * under a newer query — the classic autocomplete flicker where the list
   * disagrees with what was typed. It also means shrinking the query below two
   * characters hides the list without an effect that clears state, which would
   * cascade a render every keystroke.
   */
  const [matches, setMatches] = useState<{ query: string; rows: SponsorMatch[] }>({
    query: "",
    rows: [],
  })
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const [creating, setCreating] = useState(false)
  const [website, setWebsite] = useState("")
  const [pending, start] = useTransition()
  const listId = "sponsor-picker-list"
  const seq = useRef(0)

  const q = query.trim()
  const fresh = matches.query === q && q.length >= 2
  const results = fresh ? matches.rows : []
  const open = fresh && !dismissed
  const searching = q.length >= 2 && !fresh

  /*
   * Debounced. `contains` on an unindexed column runs per keystroke, and the
   * sequence guard drops a response that lost its race — without it a slow
   * fetch for "red" landing after "redb" would leave the tag reading "red"
   * for a query that will never be fetched again, stranding the spinner.
   */
  useEffect(() => {
    if (q.length < 2) return
    const mine = ++seq.current
    const timer = setTimeout(async () => {
      let rows: SponsorMatch[] = []
      try {
        rows = await findSponsors(q)
      } catch {
        rows = []
      }
      if (mine !== seq.current) return
      setMatches({ query: q, rows })
      setActive(0)
      setDismissed(false)
    }, 250)
    return () => clearTimeout(timer)
  }, [q])

  const exact = results.find((r) => r.exact)

  function attach(sponsorId: string, name: string) {
    start(async () => {
      try {
        const placement = await attachSponsorToEvent(eventId, sponsorId)
        toast.success(
          placement.status === "approved"
            ? `${name} added to this event`
            : `${name} invited — waiting for them to accept`
        )
        setQuery("")
        setCreating(false)
        onAttached?.()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not add that brand")
      }
    })
  }

  function createAndAttach() {
    start(async () => {
      try {
        const sponsor = await createUnclaimedSponsor({ name: q, website })
        await attachSponsorToEvent(eventId, sponsor.id)
        toast.success(`${sponsor.name} created and added`)
        setQuery("")
        setWebsite("")
        setCreating(false)
        onAttached?.()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not create that brand")
      }
    })
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const pick = results[active]
      if (pick) attach(pick.id, pick.name)
    } else if (e.key === "Escape") {
      setDismissed(true)
    }
  }

  if (creating) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
        <p className="text-[0.8125rem] leading-6">
          Creating <strong>{q}</strong>. Nobody has claimed this brand,
          so it is yours to name — the real company can claim it later and this
          placement comes with it.
        </p>
        {exact ? (
          <p className="text-[0.8125rem] leading-6 text-destructive">
            {exact.name} already exists and matches this name. Use it instead of
            creating a second one.
          </p>
        ) : results.length > 0 ? (
          <p className="text-[0.8125rem] leading-6 text-muted-foreground">
            {results.length} similar brand{results.length === 1 ? "" : "s"}{" "}
            already exist. Worth a look before you add another.
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-brand-website">Website (optional)</Label>
          <Input
            id="new-brand-website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://…"
          />
          <p className="text-[0.8125rem] text-muted-foreground">
            How the next organiser tells this brand from a similar name.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={pending || Boolean(exact)} onClick={createAndAttach}>
            Create and add
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setCreating(false)}>
            Back
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="sponsor-search">Add a sponsor</Label>
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="sponsor-search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className="pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search brands…"
        />
      </div>

      {searching ? (
        <p className="text-[0.8125rem] text-muted-foreground">Searching…</p>
      ) : null}

      {open ? (
        <ul id={listId} role="listbox" className="flex flex-col divide-y rounded-lg border bg-card">
          {results.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                disabled={pending}
                onMouseEnter={() => setActive(i)}
                onClick={() => attach(r.id, r.name)}
                className={`flex w-full flex-col gap-1 p-3 text-left ${
                  i === active ? "bg-muted" : ""
                }`}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {/*
                    Claimed status BEFORE picking, not after. An unclaimed brand
                    is added immediately; a claimed one has to be invited and
                    waits, and an organiser should know which they are choosing.
                  */}
                  <Badge variant={r.ownerName ? "default" : "outline"} className="rounded-full">
                    {r.ownerName ? `Claimed by ${r.ownerName}` : "Unclaimed"}
                  </Badge>
                  {r.exact ? (
                    <Badge variant="secondary" className="rounded-full">
                      Exact match
                    </Badge>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-3 text-[0.8125rem] text-muted-foreground">
                  {r.website ? (
                    <span className="inline-flex items-center gap-1">
                      <IconExternalLink className="size-3.5" />
                      {r.website.replace(/^https?:\/\//, "")}
                    </span>
                  ) : (
                    <span>No website</span>
                  )}
                  <span>
                    {r.placementCount === 0
                      ? "No placements yet"
                      : `${r.placementCount} placement${r.placementCount === 1 ? "" : "s"}`}
                  </span>
                </span>
              </button>
            </li>
          ))}

          {/*
            Last, always, and never the highlighted default. The duplicate
            problem is created right here — an organiser typing past an existing
            brand makes a row an admin has to merge later.
          */}
          <li>
            <button
              type="button"
              disabled={pending || q.length < 2}
              onClick={() => setCreating(true)}
              className="w-full p-3 text-left text-[0.8125rem]"
            >
              {results.length > 0 ? (
                <>None of these — add “{q}” as a new brand</>
              ) : (
                <>Add “{q}” as a new brand</>
              )}
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  )
}
