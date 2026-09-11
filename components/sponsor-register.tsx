"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  mergePreview,
  mergeSponsors,
  type AdminSponsorRow,
  type SponsorRegister,
} from "@/lib/sponsor-actions"

/**
 * The brand register, and the merge that resolves a duplicate.
 *
 * Duplicates are shown as clusters sharing a `name_key`, never merged
 * automatically: that key collapses "AT&T" and "ATT", and would collapse two
 * unrelated brands just as happily. An admin picks which row survives.
 */
export function SponsorRegisterView({ register }: { register: SponsorRegister }) {
  return (
    <div className="flex flex-col gap-8">
      {/* Only when there is something to merge. A heading over "None." was a
          section about nothing, above the list the page exists for. */}
      {register.duplicates.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[0.9375rem] font-bold">Possible duplicates</h2>
            <span className="text-[0.75rem] text-faint-foreground">
              same name key — a hint, not a verdict; check the websites before merging
            </span>
          </div>
          {register.duplicates.map((cluster) => (
            <DuplicateCluster key={cluster[0].name_key} cluster={cluster} />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[0.9375rem] font-bold">All brands</h2>
          <span className="text-[0.75rem] text-faint-foreground">
            {register.rest.length + register.duplicates.flat().length}
            {register.duplicates.length === 0 ? " · every name is distinct" : ""}
          </span>
        </div>
        {register.rest.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground">No brands yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {register.rest.map((row) => (
              <li key={row.id} className="py-3">
                <SponsorLine row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function SponsorLine({ row }: { row: AdminSponsorRow }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate font-medium">{row.name}</span>
          {/* Words, not chips. The owner is a fact; a pending claim is the one
              thing here that wants a decision, so it carries the weight. */}
          <span className="text-[0.8125rem] text-muted-foreground">{row.ownerName ?? "unclaimed"}</span>
          {row.pendingClaims > 0 ? (
            <span className="text-[0.8125rem] font-bold text-foreground">
              · {row.pendingClaims} claim{row.pendingClaims === 1 ? "" : "s"} pending
            </span>
          ) : null}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {row.website?.replace(/^https?:\/\//, "") ?? "No website"}
        </span>
      </div>
      <span className="shrink-0 text-[0.8125rem] text-muted-foreground">
        {row.placements} placement{row.placements === 1 ? "" : "s"} · {row.campaigns}{" "}
        campaign{row.campaigns === 1 ? "" : "s"}
      </span>
    </div>
  )
}

function DuplicateCluster({ cluster }: { cluster: AdminSponsorRow[] }) {
  const [keeper, setKeeper] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [preview, setPreview] = useState<{ placements: number; campaigns: number; claims: number }[] | null>(
    null
  )
  const [pending, start] = useTransition()

  const losers = cluster.filter((r) => r.id !== keeper)
  const keeperRow = cluster.find((r) => r.id === keeper)

  function confirm() {
    if (!keeper) return
    start(async () => {
      try {
        // Re-read at the point of decision. The page render could be minutes
        // old, and a merge is not reversible.
        setPreview(await Promise.all(losers.map((l) => mergePreview(l.id))))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not read what would move")
      }
    })
  }

  function merge() {
    if (!keeper) return
    start(async () => {
      try {
        // Sequential, not concurrent: each merge repoints rows the next one
        // reads, and two transactions racing on the same placements is how you
        // get a unique violation on (event_id, sponsor_id).
        for (const loser of losers) {
          await mergeSponsors(loser.id, keeper, note.trim())
        }
        toast.success(`Merged into ${keeperRow?.name}`)
        setPreview(null)
        setKeeper(null)
        setNote("")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Merge failed")
      }
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-[0.8125rem] font-medium">
          Which one survives?
        </legend>
        {cluster.map((row) => (
          <label
            key={row.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              keeper === row.id ? "border-primary bg-muted/50" : ""
            }`}
          >
            <input
              type="radio"
              name={`keeper-${cluster[0].name_key}`}
              className="mt-1.5"
              checked={keeper === row.id}
              onChange={() => {
                setKeeper(row.id)
                setPreview(null)
              }}
            />
            <span className="min-w-0 flex-1">
              <SponsorLine row={row} />
            </span>
          </label>
        ))}
      </fieldset>

      {keeper ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`note-${cluster[0].name_key}`}>Why these are the same brand</Label>
            <Input
              id={`note-${cluster[0].name_key}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Acquisition, rebrand, duplicate entry…"
            />
            <p className="text-[0.8125rem] text-muted-foreground">
              Goes in the audit log. A merge is not reversible, so the next
              person needs to know what you knew.
            </p>
          </div>

          {preview ? (
            <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-[0.8125rem] leading-6">
                Moving into <strong>{keeperRow?.name}</strong>:
              </p>
              <ul className="flex flex-col gap-1 text-[0.8125rem]">
                {losers.map((l, i) => (
                  <li key={l.id}>
                    <strong>{l.name}</strong> — {preview[i].placements} placement
                    {preview[i].placements === 1 ? "" : "s"}, {preview[i].campaigns} campaign
                    {preview[i].campaigns === 1 ? "" : "s"}, {preview[i].claims} claim
                    {preview[i].claims === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
              <p className="text-[0.8125rem] leading-6 text-muted-foreground">
                A placement on an event {keeperRow?.name} already sponsors is
                dropped rather than moved — the brand is already there.
              </p>
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="destructive" disabled={pending} onClick={merge}>
                  Merge {losers.length} into {keeperRow?.name}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPreview(null)}>
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              className="self-start"
              disabled={pending || note.trim().length < 4}
              onClick={confirm}
            >
              Review what moves
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}
