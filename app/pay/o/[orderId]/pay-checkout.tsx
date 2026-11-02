"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { loadScript } from "@/lib/load-script"

/**
 * The pay page's client half (SCRUM-1011): the hold's clock, Razorpay
 * Standard Checkout, and the states after it, as the ticketing board's
 * hand-off frames draw them: ready → Confirming… → You're in / Return to
 * Blend'n; Payment didn't go through (Try again, the hold still running);
 * Your hold ran out.
 *
 * Checkout's success handler tells the server nothing: the server does not
 * believe the browser. The page polls its status door until the signed
 * webhook has marked the order paid, every 1.5 s for 30 s, then says it is
 * still confirming and that the tickets will be in the app.
 */

export interface PayOrder {
  orderId: string
  token: string
  status: "pending" | "paid" | "refunded" | "expired" | "cancelled"
  paymentFailed: boolean
  holdExpiresAt: string
  /** The server's clock when the page was drawn: the hold is the server's, so the countdown is read on its clock. */
  serverNow: number
  providerOrderRef: string | null
  keyId: string | null
  currency: string
  eventTitle: string
  when: string
  lines: Array<{ name: string; quantity: number; unitMinor: number }>
  seats: number
  subtotalMinor: number
  feesAbsorbed: boolean
  fee: { serviceMinor: number; taxMinor: number; processingMinor: number; taxLabel: string }
  totalMinor: number
  refundLine: string
}

type Phase = "ready" | "confirming" | "paid" | "still" | "failed" | "expired" | "closed"

interface RazorpayCheckout {
  open(): void
  on(event: "payment.failed", handler: (response: { error?: { description?: string } }) => void): void
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckout
  }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js"
const POLL_MS = 1500
const POLL_FOR_MS = 30_000
const EMBER = "#F05423"

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100)

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function initialPhase(o: PayOrder): Phase {
  if (o.status === "paid") return "paid"
  if (o.status === "expired") return "expired"
  if (o.status !== "pending") return "closed"
  if (Date.parse(o.holdExpiresAt) <= o.serverNow) return "expired"
  return o.paymentFailed ? "failed" : "ready"
}

export function PayShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#0D0C0C] text-white" style={{ background: "radial-gradient(130% 50% at 50% 0%, rgba(240,84,35,.18), transparent 72%), #0D0C0C" }}>
      <main className="mx-auto flex max-w-[480px] flex-col px-5 pb-10 pt-6">
        <p className="text-[20px] font-bold leading-[26px]">Blend’n</p>
        <div className="mt-4">{children}</div>
      </main>
    </div>
  )
}

const statusUrl = (o: PayOrder) => `/pay/o/${o.orderId}/status?t=${encodeURIComponent(o.token)}`

/**
 * Time left on the hold, on the server's clock: first drawn from the server's
 * own `now` (so the server's HTML and the first client render agree), then
 * ticking on the phone's clock corrected by how far it was from the server's
 * when the page arrived. A phone set ten minutes wrong still shows the hold right.
 */
function useHoldClock(holdExpiresAt: string, serverNow: number, running: boolean) {
  const expires = Date.parse(holdExpiresAt)
  const [left, setLeft] = useState(() => expires - serverNow)
  const skew = useRef<number | null>(null)
  useEffect(() => {
    if (!running) return
    skew.current ??= serverNow - Date.now()
    const id = setInterval(() => setLeft(expires - (Date.now() + (skew.current ?? 0))), 1000)
    return () => clearInterval(id)
  }, [expires, serverNow, running])
  return left
}

export function PayCheckout({ order }: { order: PayOrder }) {
  const [stored, setPhase] = useState<Phase>(() => initialPhase(order))
  const [failure, setFailure] = useState<string | null>(null)
  const [script, setScript] = useState<"loading" | "ready" | "failed">(() => (typeof window !== "undefined" && window.Razorpay ? "ready" : "loading"))
  const [attempt, setAttempt] = useState(0)
  const holding = stored === "ready" || stored === "failed"
  const left = useHoldClock(order.holdExpiresAt, order.serverNow, holding)
  // The clock ran out while the page was open: drawn as expired, nothing to store.
  const phase: Phase = holding && left <= 0 ? "expired" : stored
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (window.Razorpay) return
    return loadScript(CHECKOUT_SRC, document, (ok) => setScript(ok && window.Razorpay ? "ready" : "failed"))
  }, [attempt])

  useEffect(() => () => void (polling.current && clearTimeout(polling.current)), [])

  const confirm = useCallback(() => {
    setPhase("confirming")
    const until = Date.now() + POLL_FOR_MS
    const tick = async () => {
      try {
        const res = await fetch(statusUrl(order), { cache: "no-store" })
        const body = res.ok ? ((await res.json()) as { status: string }) : null
        if (body?.status === "paid") return setPhase("paid")
        if (body && body.status !== "pending") return setPhase("closed")
      } catch {
        // A dropped poll is the next poll's to answer.
      }
      if (Date.now() >= until) return setPhase("still")
      polling.current = setTimeout(tick, POLL_MS)
    }
    void tick()
  }, [order])

  const pay = useCallback(async () => {
    const Checkout = window.Razorpay
    if (!Checkout || !order.keyId || !order.providerOrderRef) return
    setFailure(null)
    // A new attempt: the last one's failure no longer stands (contract §8.2).
    await fetch(statusUrl(order), { method: "POST" }).catch(() => undefined)
    const checkout = new Checkout({
      key: order.keyId,
      order_id: order.providerOrderRef,
      amount: order.totalMinor,
      currency: order.currency,
      name: "Blend’n",
      description: `${order.seats} ticket${order.seats === 1 ? "" : "s"} · ${order.eventTitle}`.slice(0, 255),
      theme: { color: EMBER },
      handler: confirm,
      modal: { confirm_close: true },
    })
    checkout.on("payment.failed", (r) => {
      setFailure(r.error?.description ?? null)
      setPhase("failed")
    })
    checkout.open()
  }, [order, confirm])

  if (phase === "paid") return <Done title="You’re in" body={`Your ${order.seats === 1 ? "ticket is" : `${order.seats} tickets are`} in Blend’n, ready for the door.`} orderId={order.orderId} />
  if (phase === "still")
    return <Done title="Still confirming…" body="Razorpay hasn’t confirmed it yet. You won’t be charged twice: your tickets appear in Blend’n as soon as it does." orderId={order.orderId} />
  if (phase === "expired")
    return <Done title="Your hold ran out" body={`We held ${order.seats === 1 ? "your ticket" : `${order.seats} tickets`} for 10 minutes. Go back to Blend’n to pick again.`} orderId={order.orderId} />
  if (phase === "closed") return <Done title="This order is closed" body="Go back to Blend’n to see where your tickets are." orderId={order.orderId} />
  if (phase === "confirming") {
    return (
      <div role="status" className="flex flex-col items-center pt-16 text-center">
        <div aria-hidden className="size-11 animate-spin rounded-full border-[3px] border-white/20 border-t-[#FF8A5C] motion-reduce:animate-none" />
        <h1 className="mt-5 text-[24px] font-bold leading-[30px] tracking-[-0.4px]">Confirming your payment</h1>
        <p className="mt-1 text-[15px] leading-[20px] text-[#B3AEAD]">A few seconds. You won’t be charged twice.</p>
      </div>
    )
  }

  const usable = script === "ready" && order.keyId && order.providerOrderRef
  return (
    <>
      <Summary order={order} left={left} />
      {phase === "failed" ? (
        <div role="alert" className="mt-5">
          <h2 className="text-[20px] font-bold leading-[26px]">Payment didn’t go through</h2>
          <p className="mt-1 text-[15px] leading-[20px] text-[#B3AEAD]">
            {failure ? `${failure} ` : ""}Nothing was charged. Your tickets are held for <span className="font-mono text-white">{clock(left)}</span> more.
          </p>
        </div>
      ) : null}
      <button
        type="button"
        onClick={pay}
        disabled={!usable}
        className="mt-6 flex h-14 w-full items-center justify-center rounded-full text-[16px] font-bold text-white disabled:opacity-50"
        style={{ background: "linear-gradient(135deg,#D83F0F 0%,#BB556B 50%,#925DA9 100%)" }}
      >
        {phase === "failed" ? "Try again" : `Pay ${money(order.totalMinor, order.currency)}`}
      </button>
      {script === "failed" ? (
        <p role="alert" className="mt-3 text-center text-[13px] text-[#B3AEAD]">
          Razorpay’s checkout couldn’t load.{" "}
          <button type="button" className="underline" onClick={() => (setScript("loading"), setAttempt((n) => n + 1))}>
            Try again
          </button>
        </p>
      ) : !order.keyId || !order.providerOrderRef ? (
        <p role="alert" className="mt-3 text-center text-[13px] text-[#B3AEAD]">
          Payments aren’t available right now. Nothing was charged.
        </p>
      ) : null}
      <p className="mt-4 text-center text-[12px] leading-[16px] text-[#B3AEAD]">
        UPI, cards and netbanking through Razorpay. By paying you agree to the{" "}
        <a href="/terms/tickets" className="underline">
          ticket terms of sale
        </a>
        .
      </p>
    </>
  )
}

function Summary({ order, left }: { order: PayOrder; left: number }) {
  const booking = order.fee.serviceMinor + order.fee.taxMinor + order.fee.processingMinor
  return (
    <section aria-label="Your order">
      <h1 className="text-[17px] font-medium leading-[22px]">{order.eventTitle}</h1>
      <p className="mt-0.5 text-[13px] leading-[18px] text-[#B3AEAD]">
        {order.lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")} · {order.when}
      </p>
      <dl className="mt-4 grid gap-1.5 rounded-2xl bg-[#242121] p-4 text-[14px] leading-[20px]">
        <Row label="Tickets" value={money(order.subtotalMinor, order.currency)} />
        {order.feesAbsorbed ? (
          <p className="text-[13px] text-[#B3AEAD]">Price includes fees</p>
        ) : (
          <>
            <Row label={`Booking fee, ${order.fee.taxLabel} included`} value={money(booking, order.currency)} />
            <p className="text-[12px] leading-[16px] text-[#9A9594]">
              Service {money(order.fee.serviceMinor, order.currency)} · {order.fee.taxLabel} {money(order.fee.taxMinor, order.currency)} · Processing{" "}
              {money(order.fee.processingMinor, order.currency)}
            </p>
          </>
        )}
        <div className="mt-1 flex items-baseline justify-between border-t border-white/10 pt-2">
          <dt className="text-[#B3AEAD]">Total</dt>
          <dd className="font-mono text-[22px] font-bold leading-[28px] tabular-nums">{money(order.totalMinor, order.currency)}</dd>
        </div>
      </dl>
      <p role="timer" aria-live="off" className="mt-3 inline-flex h-7 items-center rounded-full bg-[rgba(255,188,92,0.16)] px-2.5 text-[12px] font-medium text-[#FFBC5C]">
        Held for you · <span className="ml-1 font-mono tabular-nums">{clock(left)}</span>&nbsp;left
      </p>
      <p className="mt-3 text-[13px] leading-[18px] text-[#B3AEAD]">{order.refundLine}</p>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[#B3AEAD]">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  )
}

function Done({ title, body, orderId }: { title: string; body: string; orderId: string }) {
  return (
    <div className="pt-2">
      <h1 className="text-[24px] font-bold leading-[30px] tracking-[-0.4px]">{title}</h1>
      <p className="mt-2 text-[15px] leading-[22px] text-[#B3AEAD]">{body}</p>
      {/* Best effort: the app polls the order when the browser closes, with or without this. */}
      <a
        href={`blendn://ticket/${orderId}`}
        className="mt-6 flex h-14 items-center justify-center rounded-full text-[16px] font-bold text-white"
        style={{ background: "linear-gradient(135deg,#D83F0F 0%,#BB556B 50%,#925DA9 100%)" }}
      >
        Return to Blend’n
      </a>
    </div>
  )
}
