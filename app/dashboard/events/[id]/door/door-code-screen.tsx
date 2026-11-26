"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"

import { Button } from "@/components/ui/button"

import type { DoorView } from "./actions"

/** A code this far past its turn is not shown: it would fail at the door and the host could not tell why. */
const STALE_AFTER_MS = 5_000
/** How long an arrival keeps the echo lit. */
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
  onClose,
  onResume,
}: {
  title: string
  view: Open | null
  failed: boolean
  onClose: () => void
  onResume: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const resume = useRef<HTMLButtonElement>(null)
  const now = useNow(1000)

  const paused = !!view?.paused
  const code = view?.code ?? null
  const stale = !paused && (failed || !code || now > Date.parse(code.rotatesAt) + STALE_AFTER_MS)
  const left = code ? Math.max(0, Math.ceil((Date.parse(code.rotatesAt) - now) / 1000)) : 0
  const justIn = view?.arrivals.filter((a) => now - Date.parse(a.at) < ECHO_MS).length ?? 0
  const said = useAnnouncement(stale ? null : code?.value ?? null)

  useDialog(dialog, heading, onClose)
  useWakeLock()
  // Auto-pause is an alert, and the host's next move is Resume.
  useEffect(() => {
    if (paused) resume.current?.focus()
  }, [paused])

  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="door-code-title"
      className="@container fixed inset-0 z-50 flex flex-col items-center justify-[safe_center] gap-4 overflow-auto bg-white px-5 pt-[72px] pb-7 text-center text-black"
    >
      <Button
        variant="outline"
        onClick={onClose}
        className="absolute top-4 right-4 min-h-11 min-w-11 border-black/55 bg-white px-4 text-[0.9375rem] text-black hover:bg-black/5 hover:text-black"
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
        </div>
      ) : stale ? (
        <p role="status" className="max-w-full rounded-[10px] border border-black/20 px-4 py-3 text-[15px] leading-6">
          Reconnecting… The code is hidden until it is current again.
        </p>
      ) : code ? (
        <>
          <div aria-hidden translate="no" className="font-mono leading-none font-bold tracking-[0.06em] whitespace-nowrap tabular-nums" style={{ fontSize: "min(190px, 21cqi)" }}>
            {code.value.slice(0, 3)}
            <span className="inline-block w-[0.45em]" />
            {code.value.slice(3)}
          </div>
          <p className="sr-only" translate="no">{`Door code: ${code.value.split("").join(", ")}`}</p>
          <div aria-hidden className="h-1.5 w-[min(560px,80%)] overflow-hidden rounded-full bg-black/30 forced-colors:border forced-colors:border-[CanvasText]">
            <div
              className="h-full origin-left rounded-full bg-primary motion-safe:transition-transform motion-safe:duration-1000 motion-safe:ease-linear forced-colors:bg-[CanvasText]"
              style={{ transform: `scaleX(${left / STEP_S})` }}
            />
          </div>
          <p aria-hidden className="text-[15px] opacity-70">{`Changes in ${left} s`}</p>
          {justIn > 0 ? (
            <p className="rounded-full bg-[rgba(15,140,80,0.12)] px-3.5 py-2 text-base leading-[22px] font-semibold text-[#0b6b3a]">
              {`${justIn} just came in`}
            </p>
          ) : null}
        </>
      ) : null}
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

/** What the polite status says: "Door code changed" on a turn, "Door code is current again" after a gap. Never per second. */
function useAnnouncement(live: string | null): string {
  const [said, setSaid] = useState("")
  const previous = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const before = previous.current
    previous.current = live
    if (before === undefined || !live || before === live) return
    setSaid(before === null ? "Door code is current again" : "Door code changed")
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
      } else if (!e.shiftKey && document.activeElement === last) {
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
      if (document.visibilityState !== "visible" || !("wakeLock" in navigator)) return
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
