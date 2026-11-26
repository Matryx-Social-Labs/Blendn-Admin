"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"

import { Button } from "@/components/ui/button"

import type { DoorView } from "./actions"

/** A code this far past its turn is not shown: it would fail at the door and the host could not tell why. */
const STALE_AFTER_MS = 5_000
/** How long an arrival keeps "just now" lit on the Door tab (the full screen's count is the server's, same two minutes). */
export const ECHO_MS = 2 * 60_000
const STEP_S = 30

type Open = Extract<DoorView, { kind: "open" }>

/**
 * The full-screen door view (host B, design/02a SPEC §5, §8): white, the code
 * large enough to read across a doorway, a draining bar, and a count of who
 * just came in, never a name (it faces the queue). A focused dialog over an
 * inert page; Esc, Close and leaving full screen all close it.
 */
export function DoorCodeScreen({
  title,
  view,
  failed,
  skew,
  error,
  onClose,
  onResume,
}: {
  title: string
  view: Open | null
  failed: boolean
  /** Server clock minus this device's: the countdown and staleness run on the server's time. */
  skew: number
  /** A Resume that failed, said here: the page behind is inert and a toast would not be seen. */
  error: string | null
  onClose: () => void
  onResume: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const resume = useRef<HTMLButtonElement>(null)
  const now = useNow(1000) + skew

  const paused = !!view?.paused
  const code = view?.code ?? null
  // Not yet asked with the code is loading, not stale: nothing to announce.
  const stale = !paused && (failed || !!view?.unavailable || (!!code && now > Date.parse(code.rotatesAt) + STALE_AFTER_MS))
  const live = !paused && !stale ? code : null
  const left = live ? Math.max(0, Math.ceil((Date.parse(live.rotatesAt) - now) / 1000)) : 0
  const justIn = live ? (view?.justIn ?? 0) : 0
  const said = useAnnouncement(stale ? null : (live?.value ?? undefined))

  useDialog(dialog, heading, onClose)
  useWakeLock()
  // Auto-pause is an alert and the host's next move is Resume; after a resume, back to the heading.
  const wasPaused = useRef(paused)
  useEffect(() => {
    if (paused) resume.current?.focus()
    else if (wasPaused.current) heading.current?.focus()
    wasPaused.current = paused
  }, [paused])

  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="door-code-title"
      className="@container fixed inset-0 z-50 flex flex-col items-center justify-[safe_center] gap-4 overflow-auto bg-white px-5 pt-[72px] pb-7 text-center text-black"
    >
      {/* Fixed, not absolute: at 400% zoom the dialog scrolls and Close must not scroll away with it. */}
      <Button
        variant="outline"
        onClick={onClose}
        className="fixed top-4 right-4 z-10 min-h-11 min-w-11 border-black/55 bg-white px-4 text-[0.9375rem] text-black hover:bg-black/5 hover:text-black"
      >
        Close
      </Button>
      <h1 ref={heading} id="door-code-title" tabIndex={-1} className="max-w-[90%] text-[22px] leading-7 font-bold [overflow-wrap:anywhere] outline-none">
        <span className="sr-only">Door code, </span>
        {title}
      </h1>
      <p aria-hidden className="text-[15px] leading-5 font-semibold tracking-[0.02em] uppercase opacity-70">
        Door code · type it in Blend&rsquo;n
      </p>

      {paused ? (
        <div role="alert" className="flex max-w-full flex-col items-center gap-4">
          <p className="rounded-[10px] border border-warning/50 bg-warning/10 px-4 py-3 text-[15px] leading-6">
            {pausedSentence(view?.paused?.wrong ?? null)}
          </p>
          <Button ref={resume} onClick={onResume} className="h-12 px-6 text-[0.9375rem]">
            Resume the code
          </Button>
          {error ? <p className="text-[15px] font-semibold text-destructive">{error}</p> : null}
        </div>
      ) : live ? (
        <>
          <div aria-hidden translate="no" className="font-mono leading-none font-bold tracking-[0.06em] whitespace-nowrap tabular-nums" style={{ fontSize: "min(190px, 21cqi)" }}>
              {live.value.slice(0, 3)}
            <span className="inline-block w-[0.45em]" />
            {live.value.slice(3)}
          </div>
          <p className="sr-only" translate="no">{`Door code: ${live.value.split("").join(", ")}`}</p>
          <div aria-hidden className="h-1.5 w-[min(560px,80%)] overflow-hidden rounded-full bg-black/30 forced-colors:border forced-colors:border-[CanvasText]">
            <div
              className="h-full origin-left rounded-full bg-primary motion-safe:transition-transform motion-safe:duration-1000 motion-safe:ease-linear forced-colors:bg-[CanvasText]"
              style={{ transform: `scaleX(${left / STEP_S})` }}
            />
          </div>
          <p aria-hidden className="text-[15px] opacity-70">{`Changes in ${left} s`}</p>
        </>
      ) : null}
      {/* Live regions stay mounted so a change in them is announced: the stale notice, the echo (a count, never a name), the turn. */}
      <div role="status" className="flex max-w-full flex-col items-center">
        {stale ? (
          <p className="max-w-full rounded-[10px] border border-black/20 px-4 py-3 text-[15px] leading-6">
            Reconnecting… The code is hidden until it is current again.
          </p>
        ) : null}
      </div>
      <div role="status" className="flex max-w-full flex-col items-center">
        {justIn > 0 ? (
          <p className="rounded-full bg-[rgba(15,140,80,0.12)] px-3.5 py-2 text-base leading-[22px] font-semibold text-[#0b6b3a]">
            {`${justIn} just came in`}
          </p>
        ) : null}
      </div>
      <p role="status" className="sr-only">{said}</p>
    </div>,
    document.body
  )
}

/** "Code entry is paused. 25 wrong codes in the last 10 minutes." — the number only when the store could say. */
export function pausedSentence(wrong: number | null): string {
  if (wrong === null || wrong < 1) return "Code entry is paused."
  return `Code entry is paused. ${wrong} wrong code${wrong === 1 ? "" : "s"} in the last 10 minutes.`
}

/** The wall clock, every `everyMs`: the countdown, the echo's age, "just now". */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}

/**
 * What the polite status says: "Door code changed" on a turn, "Door code is
 * current again" after a stale gap. Never per second, nothing for the first
 * code. `live` is the code, null while stale, undefined while not loaded. A
 * trailing no-break space alternates so the same words twice are still a change.
 */
function useAnnouncement(live: string | null | undefined): string {
  const [said, setSaid] = useState("")
  const previous = useRef<string | null | undefined>(undefined)
  const count = useRef(0)
  useEffect(() => {
    if (live === undefined) return
    const before = previous.current
    previous.current = live
    if (before === undefined || !live || before === live) return
    count.current += 1
    setSaid(`${before === null ? "Door code is current again" : "Door code changed"}${count.current % 2 ? "" : "\u00a0"}`)
  }, [live])
  return said
}

/** Focus on the heading, Tab kept inside, the page behind inert, full screen where the browser allows; Esc or leaving full screen closes. */
function useDialog(dialog: RefObject<HTMLDivElement | null>, heading: RefObject<HTMLHeadingElement | null>, onClose: () => void) {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    const others = [...document.body.children].filter((el): el is HTMLElement => el !== node && el instanceof HTMLElement && !el.inert)
    others.forEach((el) => (el.inert = true))
    heading.current?.focus()
    node.requestFullscreen?.().catch(() => {
      // An iPhone has no element full screen: the fixed overlay is the view.
    })
    const onFullscreen = () => {
      if (!document.fullscreenElement) close.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current()
      if (e.key !== "Tab") return
      const stops = [...node.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")]
      if (stops.length === 0) return
      const [first, last] = [stops[0], stops[stops.length - 1]]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === heading.current) {
        // The heading takes focus on open but is no tab stop: on to the next control after it, else round to Close.
        e.preventDefault()
        ;(stops.find((el) => heading.current!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ?? first).focus()
      } else if (!e.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("fullscreenchange", onFullscreen)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen)
      document.removeEventListener("keydown", onKey)
      others.forEach((el) => (el.inert = false))
      if (document.fullscreenElement === node) void document.exitFullscreen().catch(() => {})
    }
  }, [dialog, heading])
}

/** Keep a tablet on the table awake while the code is up, where the browser has a Wake Lock. */
function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    let gone = false
    const take = () => {
      if (document.visibilityState !== "visible" || !("wakeLock" in navigator) || (lock && !lock.released)) return
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          if (gone) void l.release()
          else lock = l
        })
        .catch(() => {
          // Refused (battery saver, no permission): the screen may dim, nothing else changes.
        })
    }
    take()
    document.addEventListener("visibilitychange", take)
    return () => {
      gone = true
      document.removeEventListener("visibilitychange", take)
      void lock?.release()
    }
  }, [])
}
