"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { IconMaximize } from "@tabler/icons-react"
import { toast } from "sonner"

import { Callout, Panel } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { clockTime, formatNumber } from "@/lib/dashboard-format"
import { useOpsSnapshot } from "@/lib/use-ops-snapshot"
import { cn } from "@/lib/utils"

import { pauseEntryCode, readDoor, resumeEntryCode, type DoorArrival, type DoorView } from "./actions"
import { DoorCodeScreen, ECHO_MS, pausedSentence, useNow } from "./door-code-screen"

/** A fallback re-ask when the ops push is not arriving. */
const FALLBACK_MS = 30_000
/** After a failed re-ask, or a turn that has not landed yet, how soon to ask again while the code is up. */
const RETRY_MS = 2_000

/**
 * The Door tab (host B, design/02a SPEC §5): never draws the code. Counts by
 * code and by GPS, who came in with the code (room pseudonyms only), and the
 * one button that puts the code full screen. Re-asked on each ops push, at
 * each turn of the code while it is up (timed on the server's clock), and
 * every 30 s as a fallback.
 */
export function DoorTab({ eventId, title, timezone, initial }: { eventId: string; title: string; timezone: string; initial: DoorView }) {
  const [view, setView] = useState(initial)
  const [failures, setFailures] = useState(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Server clock minus this tablet's, from the last answer: the turn and staleness are timed by the server.
  const [skew, setSkew] = useState(0)
  const show = useRef<HTMLButtonElement>(null)
  const resumeHere = useRef<HTMLButtonElement>(null)
  const openNow = useRef(false)
  const wasOpen = useRef(false)
  const sent = useRef(0)
  const applied = useRef(0)
  const { snapshot } = useOpsSnapshot(eventId, view.kind === "open")
  const now = useNow(15_000)

  /** Ask again; the newest answer wins, and one asked before the view opened never blanks its code. */
  const refresh = useCallback(async () => {
    const n = ++sent.current
    const withCode = openNow.current
    try {
      const next = await readDoor(eventId, withCode)
      if (n <= applied.current || (openNow.current && !withCode)) return
      applied.current = n
      setView(next)
      setFailures(0)
      if (next.kind === "open") setSkew(Date.parse(next.serverNow) - Date.now())
      else setOpen(false)
    } catch {
      if (n > applied.current) setFailures((f) => f + 1)
    }
  }, [eventId])

  useEffect(() => {
    openNow.current = open
  }, [open])

  useEffect(() => {
    if (snapshot) void refresh()
  }, [snapshot, refresh])

  useEffect(() => {
    const id = setInterval(() => void refresh(), FALLBACK_MS)
    return () => clearInterval(id)
  }, [refresh])

  // While the code is up: ask as it turns (re-armed after every answer), or soon after a failure.
  useEffect(() => {
    if (!open) return
    const rotatesAt = view.kind === "open" ? view.code?.rotatesAt : undefined
    const untilTurn = rotatesAt ? Date.parse(rotatesAt) - (Date.now() + skew) + 250 : RETRY_MS
    const id = setTimeout(() => void refresh(), failures > 0 || untilTurn <= 0 ? RETRY_MS : untilTurn)
    return () => clearTimeout(id)
  }, [open, view, failures, skew, refresh])

  // Focus goes back to whatever opened the view (Resume, when the code was paused meanwhile).
  useEffect(() => {
    if (wasOpen.current && !open) (show.current ?? resumeHere.current)?.focus()
    wasOpen.current = open
  }, [open])

  function openScreen() {
    openNow.current = true
    setOpen(true)
    void refresh()
  }

  async function act(action: (id: string) => Promise<DoorView>, failure: string, then: "show" | "resume") {
    setBusy(true)
    setActionError(null)
    try {
      await action(eventId)
      await refresh()
      // The button that was pressed is gone: focus the one that replaced it.
      requestAnimationFrame(() => (then === "show" ? show.current : resumeHere.current)?.focus())
    } catch {
      setActionError(failure)
      toast.error(failure)
    } finally {
      setBusy(false)
    }
  }

  async function remove(arrival: DoorArrival) {
    if (!confirm(`Remove ${arrival.pseudonym} from the room? They can't use the door code again tonight.`)) return
    const res = await fetch(`/api/events/${eventId}/chat/members/${encodeURIComponent(arrival.ref)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ban" }),
    }).catch(() => null)
    if (res?.ok) toast.success(`${arrival.pseudonym} was removed from the room`)
    else toast.error(res ? `Could not remove them (${res.status}). Try again.` : "Could not reach the server. Try again.")
    await refresh()
  }

  if (view.kind !== "open") {
    return (
      <Panel title="Door code">
        <p className="text-[0.875rem] text-muted-foreground">
          {view.kind === "closed" ? "The door code is off until the next doors, 90 minutes before the start." : "You can't see this event's door."}
        </p>
      </Panel>
    )
  }

  const paused = view.paused
  const offline = failures > 0 || view.unavailable
  const chip = paused ? { label: "Paused", tone: "border-warning" } : offline ? { label: "Offline", tone: "border-warning" } : { label: "On", tone: "border-success" }
  const resume = () => void act(resumeEntryCode, "Could not resume the code. Try again.", "show")

  return (
    <div className="grid gap-5 @3xl/main:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Door code" action={<span className={cn("rounded-full border px-2.5 py-0.5 text-[0.8125rem] font-medium text-foreground", chip.tone)}>{chip.label}</span>}>
        <p className="text-[0.875rem] leading-[22px] text-muted-foreground">
          For guests whose GPS can&rsquo;t place them. Show it full screen at the entrance; it changes every 30 seconds.
        </p>
        {view.unavailable && !paused ? (
          <Callout role="status" title="The door code isn't working right now">Guests can still check in with GPS. It comes back by itself.</Callout>
        ) : null}
        {paused ? (
          <>
            <Callout role="alert" title={pausedSentence(paused.wrong)}>It comes back by itself 10 minutes after the pause.</Callout>
            <Button ref={resumeHere} disabled={busy} onClick={resume} className="w-fit pointer-coarse:h-11">
              Resume the code
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button ref={show} aria-haspopup="dialog" onClick={openScreen} className="h-11 px-5 text-[0.9375rem]">
              <IconMaximize aria-hidden className="size-4" />
              Show the door code
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void act(pauseEntryCode, "Could not pause the code. Try again.", "resume")} className="h-11">
              Pause the code
            </Button>
          </div>
        )}
      </Panel>

      <Panel title="Came in with the code">
        <p className="flex flex-wrap gap-x-7 gap-y-2">
          <span className="flex flex-col">
            <b className="text-[1.75rem] leading-8 font-bold tabular-nums">{formatNumber(view.byCode)}</b>
            <span className="text-[0.875rem] text-muted-foreground">with the code tonight</span>
          </span>
          <span className="flex flex-col">
            <b className="text-[1.75rem] leading-8 font-bold tabular-nums">{formatNumber(view.byGps)}</b>
            <span className="text-[0.875rem] text-muted-foreground">with GPS</span>
          </span>
        </p>
        {view.arrivals.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground">Nobody has come in with the code yet.</p>
        ) : (
          <ul className="flex flex-col">
            {view.arrivals.map((a, i) => (
              <ArrivalRow key={a.ref} arrival={a} timezone={timezone} fresh={i === 0 && now - Date.parse(a.at) < ECHO_MS} onRemove={() => void remove(a)} />
            ))}
          </ul>
        )}
      </Panel>

      {open ? (
        <DoorCodeScreen title={title} view={view} failed={failures > 0} skew={skew} error={actionError} onClose={() => setOpen(false)} onResume={resume} />
      ) : null}
    </div>
  )
}

function ArrivalRow({ arrival, timezone, fresh, onRemove }: { arrival: DoorArrival; timezone: string; fresh: boolean; onRemove: () => void }) {
  const at = new Date(arrival.at)
  const initials = arrival.pseudonym
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
  return (
    <li className={cn("flex items-center gap-3 border-b border-border py-3 last:border-b-0", fresh && "rounded-[10px] border-b-0 bg-success/10 px-3")}>
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-[0.75rem] font-bold text-muted-foreground">
        {initials}
      </span>
      <span className="min-w-0 flex-1 text-[0.9375rem] [overflow-wrap:anywhere]">
        {arrival.pseudonym}
        {fresh ? <span className="text-[0.8125rem] font-medium text-foreground dark:text-success"> · just now</span> : null}
      </span>
      <time dateTime={arrival.at} className="shrink-0 text-[0.9375rem] tabular-nums text-muted-foreground">
        {clockTime(at, timezone)}
      </time>
      <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${arrival.pseudonym} from the room`} className="shrink-0 text-muted-foreground pointer-coarse:h-11">
        Remove
      </Button>
    </li>
  )
}
