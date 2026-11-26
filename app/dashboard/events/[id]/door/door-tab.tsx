"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { IconMaximize } from "@tabler/icons-react"
import { toast } from "sonner"

import { Callout, Panel } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { formatNumber } from "@/lib/dashboard-format"
import { useOpsSnapshot } from "@/lib/use-ops-snapshot"
import { cn } from "@/lib/utils"

import { pauseEntryCode, readDoor, resumeEntryCode, type DoorArrival, type DoorView } from "./actions"
import { DoorCodeScreen, ECHO_MS, pausedSentence, useNow } from "./door-code-screen"

/** A fallback re-ask when the ops push is not arriving. */
const FALLBACK_MS = 30_000
/** After a failed re-ask, how soon to try again while the code is up. */
const RETRY_MS = 2_000

/**
 * The Door tab (host B, design/02a SPEC §5): never draws the code. Counts by
 * code and by GPS, who came in with the code (room pseudonyms only), and the
 * one button that puts the code full screen. Re-asked on each ops push, at
 * each turn of the code while it is up, and every 30 s as a fallback.
 */
export function DoorTab({ eventId, title, timezone, initial }: { eventId: string; title: string; timezone: string; initial: DoorView }) {
  const [view, setView] = useState(initial)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const show = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const asked = useRef(0)
  const { snapshot } = useOpsSnapshot(eventId, view.kind === "open")
  const now = useNow(15_000)

  const refresh = useCallback(
    async (withCode: boolean) => {
      const n = ++asked.current
      try {
        const next = await readDoor(eventId, withCode)
        if (n === asked.current) {
          setView(next)
          setFailed(false)
        }
      } catch {
        if (n === asked.current) setFailed(true)
      }
    },
    [eventId]
  )

  useEffect(() => {
    if (snapshot || open) void refresh(open)
  }, [snapshot, open, refresh])

  useEffect(() => {
    const id = setInterval(() => void refresh(open), FALLBACK_MS)
    return () => clearInterval(id)
  }, [open, refresh])

  // While the code is up: ask again as it turns, or soon after a failure.
  const rotatesAt = view.kind === "open" ? view.code?.rotatesAt : undefined
  useEffect(() => {
    if (!open || (!rotatesAt && !failed)) return
    const wait = failed || !rotatesAt ? RETRY_MS : Math.max(Date.parse(rotatesAt) - Date.now() + 250, 0)
    const id = setTimeout(() => void refresh(true), wait)
    return () => clearTimeout(id)
  }, [open, rotatesAt, failed, refresh])

  // Focus goes back to "Show the door code" when the view closes.
  useEffect(() => {
    if (wasOpen.current && !open) show.current?.focus()
    wasOpen.current = open
  }, [open])

  async function act(action: (id: string) => Promise<DoorView>, failure: string) {
    setBusy(true)
    try {
      setView(await action(eventId))
      await refresh(open)
    } catch {
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
    else toast.error("Could not remove them. Try again.")
    await refresh(open)
  }

  if (view.kind !== "open") {
    return (
      <Panel title="Door code">
        <p className="text-[0.875rem] text-muted-foreground">
          {view.kind === "closed" ? "The door code appears 90 minutes before the start, and goes at the end." : "You can't see this event's door."}
        </p>
      </Panel>
    )
  }

  const paused = view.paused
  const chip = paused ? { label: "Paused", tone: "border-warning/50 text-warning" } : failed ? { label: "Offline", tone: "border-warning/50 text-warning" } : { label: "On", tone: "border-success/50 text-success" }

  return (
    <div className="grid gap-5 @3xl/main:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Door code" action={<span className={cn("rounded-full border px-2.5 py-0.5 text-[0.8125rem] font-medium", chip.tone)}>{chip.label}</span>}>
        <p className="text-[0.875rem] leading-[22px] text-muted-foreground">
          For guests whose GPS can&rsquo;t place them. Show it full screen at the entrance; it changes every 30 seconds.
        </p>
        {paused ? (
          <>
            <Callout role="alert" title={pausedSentence(paused.wrong)} />
            <Button disabled={busy} onClick={() => void act(resumeEntryCode, "Could not resume the code. Try again.")} className="w-fit pointer-coarse:h-11">
              Resume the code
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button ref={show} aria-haspopup="dialog" onClick={() => setOpen(true)} className="h-11 px-5 text-[0.9375rem]">
              <IconMaximize aria-hidden className="size-4" />
              Show the door code
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void act(pauseEntryCode, "Could not pause the code. Try again.")} className="h-11">
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
        <DoorCodeScreen
          title={title}
          view={view}
          failed={failed}
          onClose={() => setOpen(false)}
          onResume={() => void act(resumeEntryCode, "Could not resume the code. Try again.")}
        />
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
        {fresh ? <span className="text-[0.8125rem] text-success"> · just now</span> : null}
      </span>
      <time dateTime={arrival.at} className="shrink-0 text-[0.9375rem] tabular-nums text-muted-foreground">
        {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(at)}
      </time>
      <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${arrival.pseudonym} from the room`} className="shrink-0 text-muted-foreground pointer-coarse:h-11">
        Remove
      </Button>
    </li>
  )
}
