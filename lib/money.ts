/**
 * Minor units as a person reads them: Indian grouping for rupees ("₹37,59,726"),
 * the market's own for anything else. Client-safe: the Tickets tab's editor
 * prices a type in the browser with the same function the server renders with.
 */
const LOCALE: Record<string, string> = { INR: "en-IN", CAD: "en-CA" }

export function formatMinor(minor: number, currency: string, opts: { paise?: boolean } = {}): string {
  const digits = opts.paise ? 2 : minor % 100 === 0 ? 0 : 2
  return new Intl.NumberFormat(LOCALE[currency] ?? "en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 100)
}

/** A rate in basis points as a percentage: 350 → "3.5%". */
export const formatBps = (bps: number) => `${Number((bps / 100).toFixed(2))}%`

const COUNT = new Intl.NumberFormat("en-IN")
/** A count with Indian grouping: 2274 → "2,274", 150000 → "1,50,000". */
export const formatCount = (n: number) => COUNT.format(n)
