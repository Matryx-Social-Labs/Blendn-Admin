/**
 * The Plan and Analytics states step 16's later fixes added, put through the
 * design chain in step 16f (docs/DASHBOARD-REDESIGN-CHECKLIST.md): checkout
 * loading / couldn't load / retry, "taking longer than usual", the access line,
 * the arrival bars. Each is asserted on what a person gets, because each looked
 * fine in a screenshot and was wrong: a Try again that never retried, a Buy
 * button that looked pressable while it was not, a title squeezed to "Pay…".
 */
import { renderToStaticMarkup } from "react-dom/server"

// The page's server actions pull in auth; none of them run in these renders.
jest.mock("@/lib/billing-actions", () => ({
  cancelAnalytics: jest.fn(),
  cancelVenuePro: jest.fn(),
  startAnalyticsCheckout: jest.fn(),
  startEventPassCheckout: jest.fn(),
  startVenueProCheckout: jest.fn(),
}))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }))

import { LateNotice, Unavailable } from "@/app/dashboard/plan/checkout"
import { ArrivalBars } from "@/components/dashboard/analytics-panels"
import { Panel } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { analyticsAccessLine, FIRST_EVENT_RULE } from "@/lib/access-line-copy"
import { loadScript } from "@/lib/load-script"

/** The few parts of a script element and a document the loader touches. */
function fakeDocument() {
  const appended: { src?: string; async?: boolean; onload: (() => void) | null; onerror: (() => void) | null; removed: boolean; remove(): void }[] = []
  const head = { appendChild: (el: (typeof appended)[number]) => void appended.push(el) }
  const doc = {
    head,
    createElement: () => {
      const el = { onload: null, onerror: null, removed: false, remove() { el.removed = true } } as (typeof appended)[number]
      return el
    },
  }
  return { doc: doc as unknown as Pick<Document, "createElement" | "head">, appended }
}

describe("loadScript", () => {
  it("loads again after a failure instead of remembering it", () => {
    const { doc, appended } = fakeDocument()
    const results: boolean[] = []

    loadScript("https://checkout.example/v1/checkout.js", doc, (ok) => results.push(ok))
    appended[0].onerror?.()
    loadScript("https://checkout.example/v1/checkout.js", doc, (ok) => results.push(ok))
    appended[1].onload?.()

    // Two elements, the failed one gone from <head>, and the second attempt answered.
    expect(appended).toHaveLength(2)
    expect(appended[0].removed).toBe(true)
    expect(appended[1].src).toBe("https://checkout.example/v1/checkout.js")
    expect(results).toEqual([false, true])
  })

  it("answers a pending load that unmounted first with nothing", () => {
    const { doc, appended } = fakeDocument()
    const results: boolean[] = []

    const cancel = loadScript("https://checkout.example/v1/checkout.js", doc, (ok) => results.push(ok))
    cancel()
    appended[0].onload?.()

    expect(appended[0].removed).toBe(true)
    expect(results).toEqual([])
  })
})

describe("Unavailable (why Buy cannot be pressed)", () => {
  const html = (props: Parameters<typeof Unavailable>[0]) => renderToStaticMarkup(<Unavailable {...props} />)

  it("says nothing when Buy can be pressed", () => {
    expect(html({ reason: null, failed: false, retry: () => {} })).toBe("")
  })

  it("says that checkout is loading quietly, with no button", () => {
    const out = html({ reason: "Checkout is loading…", failed: false, retry: () => {} })
    expect(out).toContain('role="status"')
    expect(out).toContain("Checkout is loading")
    expect(out).not.toContain("<button")
  })

  it("makes a checkout that could not load an alert with a Try again button", () => {
    const out = html({ reason: "Checkout couldn't load.", failed: true, retry: () => {} })
    expect(out).toContain('role="alert"')
    expect(out).toContain("text-destructive")
    expect(out).toMatch(/<button[^>]*type="button"[^>]*>Try again<\/button>/)
    // The button takes the foreground colour: inheriting the alert's red measured 4.21:1 on the card.
    expect(/<button[^>]*class="([^"]*)"[^>]*>Try again/.exec(out)?.[1].split(" ")).toContain("text-foreground")
  })
})

describe("LateNotice (taking longer than usual)", () => {
  it("is a status callout that quotes the reference in monospace", () => {
    const out = renderToStaticMarkup(<LateNotice reference="sub_Abc123" />)
    expect(out).toContain('role="status"')
    expect(out).toContain("Taking longer than usual")
    expect(out).toMatch(/<span class="font-mono[^"]*">sub_Abc123<\/span>/)
    expect(out).toContain("support@blendn.app")
  })

  it("points at the receipt when there is no reference", () => {
    expect(renderToStaticMarkup(<LateNotice reference={null} />)).toContain("on your receipt")
  })
})

describe("a button that is aria-disabled", () => {
  it("looks disabled, and stays focusable and reachable", () => {
    const out = renderToStaticMarkup(<Button aria-disabled>Start Analytics</Button>)
    expect(out).toContain("aria-disabled:opacity-50")
    expect(out).toContain("aria-disabled:cursor-not-allowed")
    expect(out).not.toContain("aria-disabled:pointer-events-none")
  })
})

describe("Panel heading", () => {
  it("lets a long hint wrap under the title instead of squeezing the title", () => {
    const out = renderToStaticMarkup(
      <Panel title="Payments" hint="Invoices are issued through Razorpay by a company with a long name">
        body
      </Panel>
    )
    const row = /<div class="([^"]*)"><h2/.exec(out)?.[1] ?? ""
    expect(row).toContain("flex-wrap")
  })
})

describe("analyticsAccessLine", () => {
  const day = (iso: string) => `D(${iso.slice(0, 10)})`
  const base = { org: false, reason: "free" as const, freeUntil: null, date: null, firstFreeEvent: null }
  const first = { id: "e1", title: "Sunday Soul Sante", endedAt: "2026-09-23T20:00:00.000Z" }

  it("headlines an open window with its date and says what happens after it", () => {
    const line = analyticsAccessLine({ ...base, reason: "free_window", freeUntil: "2026-10-23T20:00:00.000Z", firstFreeEvent: first }, day)
    expect(line.headline).toBe("Open until D(2026-10-23)")
    expect(line.detail).toContain(`Sunday Soul Sante, ${FIRST_EVENT_RULE}, ended D(2026-09-23)`)
    expect(line.detail).toContain("After that Sunday Soul Sante stays open for good, and an Event Pass or Analytics opens the rest.")
  })

  it("says an open window with no date yet is open for now, by the rule in plain words", () => {
    const line = analyticsAccessLine({ ...base, reason: "free_window" }, day)
    expect(line.headline).toBe("Open for now")
    expect(line.detail).toBe(`Everything here is open until 30 days after ${FIRST_EVENT_RULE}.`)
  })

  it("never uses the internal word for the five-person rule", () => {
    const lines = [
      analyticsAccessLine({ ...base, reason: "free_window", freeUntil: "2026-10-23T20:00:00.000Z", firstFreeEvent: first }, day),
      analyticsAccessLine({ ...base, reason: "free_window" }, day),
      analyticsAccessLine({ ...base, firstFreeEvent: first }, day),
      analyticsAccessLine({ ...base }, day),
    ]
    for (const l of lines) expect(`${l.headline} ${l.detail}`).not.toMatch(/privacy floor/i)
    expect(FIRST_EVENT_RULE).toContain("5 people")
  })

  it("keeps the grant, subscription and free-plan lines", () => {
    const date = { word: "renews" as const, at: "2026-11-12T00:00:00.000Z" }
    expect(analyticsAccessLine({ ...base, org: true, reason: "grant", date: { word: "until", at: date.at } }, day).headline).toBe("Founding grant, until D(2026-11-12)")
    expect(analyticsAccessLine({ ...base, org: true, reason: "analytics", date }, day)).toEqual({ headline: "Analytics, renews D(2026-11-12)", detail: "Every view, for every event." })
    expect(analyticsAccessLine({ ...base, firstFreeEvent: first }, day).detail).toContain("Sunday Soul Sante stays open for good.")
    expect(analyticsAccessLine(base, day).headline).toBe("Free plan")
  })
})

describe("ArrivalBars", () => {
  // Three bars: 2 people in one slot, a 6-person peak, then a quiet 3-slot stretch of 7.
  const arrivals = [
    { from: "2026-10-03T14:00:00.000Z", to: "2026-10-03T14:20:00.000Z", people: 4 },
    { from: "2026-10-03T14:20:00.000Z", to: "2026-10-03T14:30:00.000Z", people: 6 },
    { from: "2026-10-03T14:30:00.000Z", to: "2026-10-03T15:00:00.000Z", people: 11 },
  ]
  const out = renderToStaticMarkup(<ArrivalBars arrivals={arrivals} />)

  it("says the total and the busiest ten minutes in text a phone can see", () => {
    const visible = /<span aria-hidden="true"[^>]*>([^<]*(?:<!-- -->[^<]*)*)<\/span>/.exec(out)?.[1].replace(/<!-- -->/g, "") ?? ""
    expect(visible).toContain("21 first arrivals")
    expect(visible).toContain("busiest")
    expect(visible).toMatch(/, 6$/)
  })

  it("writes the busiest bar's count on the bar, and only on that bar", () => {
    const bars = out.match(/<div title="[^"]*"[^>]*>[^<]*<\/div>/g) ?? []
    expect(bars).toHaveLength(3)
    expect(bars.filter((b) => />\d+<\/div>$/.test(b))).toHaveLength(1)
    expect(bars.find((b) => />6<\/div>$/.test(b))).toBeDefined()
  })

  it("keeps the axis to its two times, and the merge note on a line of its own", () => {
    const axis = /<div class="flex justify-between whitespace-nowrap[^"]*">(.*?)<\/div>/.exec(out)?.[1] ?? ""
    expect(axis.match(/<span>/g)).toHaveLength(2)
    expect(axis).not.toContain("quiet stretch")
    expect(out).toMatch(/<p class="[^"]*">A quiet stretch is merged into the bar beside it until it holds 5/)
  })
})
