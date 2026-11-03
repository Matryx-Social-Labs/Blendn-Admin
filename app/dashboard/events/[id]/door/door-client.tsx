"use client"

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react"
import { IconCamera, IconX } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { eventClock } from "@/lib/event-phase"
import { formatCount } from "@/lib/money"
import { cn } from "@/lib/utils"

import { admitTicket, type DoorReply } from "./actions"

/**
 * The door's phone (mockup state 8). Typing the sixth character, or a scan,
 * lets the ticket in: one step, one write (`redeemTicket`), so two doors can
 * never both admit one ticket. The answer is a word, the ticket type and a
 * time, never a person. "Checked on this device" is this tab's memory only:
 * no row records a refusal, and the door has no id.
 *
 * Scanning uses the browser's own BarcodeDetector (Chrome on Android): no
 * scanning library, and typed entry is the fallback wherever it is missing
 * (Safari on iPhone today).
 */

/** `DOOR_CODE_ALPHABET` (lib/tickets.ts): Crockford base32 less 0 O 1 I L U. Kept here so the client bundle has no server import. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
const LENGTH = 6
const HISTORY = 20
const SCAN_EVERY_MS = 250

type Seen = { code: string; type: string; result: string; ok: boolean; at: string }

const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike
  }
}

export function DoorClient({ eventId, timezone, initialCount }: { eventId: string; timezone: string; initialCount: { inside: number; of: number } }) {
  const [chars, setChars] = useState<string[]>(Array(LENGTH).fill(""))
  const [reply, setReply] = useState<DoorReply | null>(null)
  const [count, setCount] = useState(initialCount)
  const [seen, setSeen] = useState<Seen[]>([])
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [scanning, setScanning] = useState(false)
  const [scanFailed, setScanFailed] = useState(false)
  // The browser's own detector and a camera, or typed entry: read on the client only (false on the server's render).
  const hasDetector = useSyncExternalStore(
    () => () => {},
    () => "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia,
    () => false
  )
  const canScan = hasDetector && !scanFailed
  const [pending, start] = useTransition()
  const boxes = useRef<Array<HTMLInputElement | null>>([])
  const video = useRef<HTMLVideoElement>(null)
  const next = useRef<HTMLButtonElement>(null)

  // The event's clock, not the phone's: a door staffer abroad still reads the venue's time.
  const clock = eventClock(timezone)
  const focusFirst = () => boxes.current[0]?.focus()
  const time = (iso: string) => clock.format(new Date(iso), { hour: "numeric", minute: "2-digit", hour12: true })
  const waiting = waitUntil > now
  const locked = pending || waiting || reply !== null

  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(t)
      // Back to typing the moment the wait is over.
      requestAnimationFrame(focusFirst)
    }
  }, [waiting])
  useEffect(() => {
    if (reply) next.current?.focus()
  }, [reply])

  function remember(r: DoorReply, typed: string | null) {
    const at = new Date().toISOString()
    const row: Seen | null =
      r.kind === "let_in"
        ? { code: r.code, type: r.typeName, result: "Let in", ok: true, at }
        : r.kind === "used"
          ? { code: r.code, type: r.typeName, result: `Already used at ${time(r.at)}`, ok: false, at }
          : r.kind === "invalid"
            ? { code: r.code ?? typed ?? "QR", type: "—", result: "Not valid for this event", ok: false, at }
            : null
    if (row) setSeen((s) => [row, ...s].slice(0, HISTORY))
  }

  function submit(credential: { code: string } | { qr: string }) {
    const typed = "code" in credential ? credential.code : null
    start(async () => {
      try {
        const r = await admitTicket(eventId, credential)
        if (r.kind === "wait") {
          setWaitUntil(Date.now() + r.retryAfter * 1000)
          setNow(Date.now())
          setChars(Array(LENGTH).fill(""))
          return
        }
        if (r.kind === "let_in") setCount(r.count)
        remember(r, typed)
        setReply(r)
      } catch {
        setReply({ kind: "off" })
      }
    })
  }

  function reset() {
    setReply(null)
    setChars(Array(LENGTH).fill(""))
    requestAnimationFrame(focusFirst)
  }

  function type(at: number, raw: string) {
    const clean = raw.toUpperCase().split("").filter((c) => ALPHABET.includes(c))
    if (raw && clean.length === 0) return
    const filled = [...chars]
    if (clean.length === 0) filled[at] = ""
    clean.slice(0, LENGTH - at).forEach((c, i) => (filled[at + i] = c))
    setChars(filled)
    const last = Math.min(LENGTH - 1, at + Math.max(clean.length, 1))
    if (clean.length) boxes.current[filled.findIndex((c) => !c) === -1 ? last : filled.findIndex((c) => !c)]?.focus()
    if (filled.every(Boolean)) submit({ code: filled.join("") })
  }

  async function scan() {
    if (!window.BarcodeDetector || !navigator.mediaDevices) return
    setScanning(true)
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      const v = video.current
      if (!v) return
      v.srcObject = stream
      await v.play()
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] })
      for (;;) {
        if (!video.current?.srcObject) return
        const [hit] = await detector.detect(v).catch(() => [])
        if (hit?.rawValue) {
          submit({ qr: hit.rawValue })
          return
        }
        await new Promise((r) => setTimeout(r, SCAN_EVERY_MS))
      }
    } catch {
      // No camera, or permission refused: typed entry it is.
      setScanFailed(true)
    } finally {
      stream?.getTracks().forEach((t) => t.stop())
      if (video.current) video.current.srcObject = null
      setScanning(false)
    }
  }

  const stopScan = () => {
    const v = video.current
    ;(v?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop())
    if (v) v.srcObject = null
    setScanning(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col items-center gap-4 rounded-panel border border-border bg-card px-4 py-6 @xl/main:px-5 @xl/main:py-7" aria-labelledby="door-label">
        <p className="self-stretch text-right text-[0.8125rem] text-muted-foreground" aria-live="polite">
          <b className="text-foreground tabular-nums">{formatCount(count.inside)}</b> of {formatCount(count.of)} in
        </p>
        <p id="door-label" className="text-muted-foreground">
          Type the code on their ticket
        </p>
        <div role="group" aria-labelledby="door-label" className="flex justify-center gap-1.5 @xl/main:gap-2">
          {chars.map((c, i) => (
            <span key={i} className={cn("contents", i === 3 && "[&>input]:ml-2.5")}>
              <input
                ref={(el) => {
                  boxes.current[i] = el
                }}
                value={c}
                aria-label={`Character ${i + 1}`}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={i === 0}
                disabled={locked}
                onChange={(e) => type(i, e.target.value.slice(c ? 1 : 0) || e.target.value)}
                onPaste={(e) => {
                  e.preventDefault()
                  type(i, e.clipboardData.getData("text"))
                }}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && !c && i > 0) {
                    e.preventDefault()
                    const filled = [...chars]
                    filled[i - 1] = ""
                    setChars(filled)
                    boxes.current[i - 1]?.focus()
                  }
                }}
                className="h-[58px] w-[46px] rounded-[10px] border border-border-strong bg-foreground/[0.03] text-center font-mono text-[1.625rem] font-bold uppercase disabled:opacity-60 @xl/main:h-[68px] @xl/main:w-14 @xl/main:text-[2rem]"
              />
            </span>
          ))}
        </div>
        {canScan ? (
          scanning ? (
            <div className="flex w-full max-w-[420px] flex-col items-center gap-2">
              <video ref={video} muted playsInline className="aspect-square w-full rounded-lg bg-black object-cover" aria-label="Camera, looking for a ticket QR" />
              <Button variant="outline" onClick={stopScan} className="h-11">
                <IconX aria-hidden />
                Stop scanning
              </Button>
            </div>
          ) : (
            <Button variant="outline" className="h-11" disabled={locked} onClick={scan}>
              <IconCamera aria-hidden />
              Scan QR
            </Button>
          )
        ) : (
          <p className="text-[0.8125rem] text-faint-foreground">This browser can’t scan. Type the code under the QR.</p>
        )}
        {waiting ? (
          <p role="alert" className="text-[0.875rem] font-medium text-warning">
            {/* Announced once: the ticking number is for eyes, not read out every second. */}
            Too many codes in a minute. <span aria-hidden>Wait {Math.ceil((waitUntil - now) / 1000)} seconds.</span>
            <span className="sr-only">Wait a minute, then type the code again.</span>
          </p>
        ) : null}
        {reply ? <Result reply={reply} time={time} onNext={reset} nextRef={next} /> : null}
      </section>

      <section className="rounded-panel border border-border bg-card" aria-labelledby="door-seen">
        <h2 id="door-seen" className="px-5 pt-4 text-panel-title font-bold">
          Checked on this device
        </h2>
        <div className="overflow-x-auto p-5 pt-3">
          {seen.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing checked yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[0.75rem] text-faint-foreground">
                  <th className="py-2 pr-3 font-medium">Code</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Result</th>
                  <th className="py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {seen.map((s, i) => (
                  <tr key={`${s.at}-${i}`} className="border-b border-border last:border-0">
                    <td className="py-2.5 pr-3 font-mono whitespace-nowrap">{s.code.length === LENGTH ? spaced(s.code) : s.code}</td>
                    <td className="py-2.5 pr-3">{s.type}</td>
                    <td className={cn("py-2.5 pr-3 text-[0.8125rem] font-medium", s.ok ? "text-success" : "text-destructive")}>{s.result}</td>
                    <td className="py-2.5 whitespace-nowrap text-muted-foreground">{time(s.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}

function Result({ reply: r, time, onNext, nextRef }: { reply: DoorReply; time: (iso: string) => string; onNext: () => void; nextRef: React.RefObject<HTMLButtonElement | null> }) {
  const ok = r.kind === "let_in"
  const [big, why, hint, again] =
    r.kind === "let_in"
      ? [`Let in · ${r.typeName}`, `Ticket ${r.nth} of ${r.of} on this order · ${time(r.at)}`, null, "Next ticket"]
      : r.kind === "used"
        ? ["Already used", `${r.typeName} · let in at ${time(r.at)}`, "Don’t let them in. If they say it’s theirs, the buyer can see the order in their app.", "Next ticket"]
        : r.kind === "invalid"
          ? ["Not valid", "No ticket for this event has this code, or it was refunded.", "Read it back to them once. Codes never use 0, O, 1, I, L or U.", "Try again"]
          : r.kind === "not_authorized"
            ? ["Not your door", "Only the people running this event can check its tickets.", null, "Try again"]
            : ["Can’t check right now", "Ticket checking is unavailable. Try again in a moment.", null, "Try again"]
  return (
    <div
      role={ok ? "status" : "alert"}
      aria-live={ok ? "assertive" : undefined}
      className={cn(
        "flex w-full max-w-[620px] flex-col items-start gap-1 rounded-panel px-[18px] py-4",
        ok ? "bg-success/15 shadow-[inset_0_0_0_1px] shadow-success/55" : "bg-destructive/15 shadow-[inset_0_0_0_1px] shadow-destructive/55"
      )}
    >
      <p className={cn("text-[1.375rem] font-bold leading-tight", ok ? "text-success" : "text-[oklch(0.8_0.13_12.5)]")}>{big}</p>
      <p className="text-sm">{why}</p>
      {hint ? <p className="text-[0.8125rem] text-muted-foreground">{hint}</p> : null}
      <Button ref={nextRef} variant="outline" className="mt-2 h-11 w-full" onClick={onNext}>
        {again}
      </Button>
    </div>
  )
}
