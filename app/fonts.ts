import localFont from "next/font/local"

/**
 * Satoshi — the guideline's typeface, "for both presentation & web usage"
 * (page 7). Self-hosted rather than pulled from Fontshare's CDN so the render
 * does not block on a third-party host; the ITF Free Font License permits it.
 *
 * Fontshare publishes 300/400/500/700/900 and no 600. The UI leans on
 * `font-semibold` (600) in a lot of places, which CSS font matching resolves
 * upward to the 700 face — a real weight, not a synthesised one — so the
 * missing 600 costs nothing and saves a 25 kB download.
 *
 * `--font-satoshi` feeds `--font-sans` in globals.css, so every existing
 * `font-sans` and every unstyled element picks this up with no per-component
 * change.
 */
export const satoshi = localFont({
  src: [
    { path: "./fonts/Satoshi-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Satoshi-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Satoshi-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-satoshi",
  display: "swap",
  // Satoshi is geometric and runs slightly wide; matching the fallback's
  // metrics keeps the swap from reflowing the KPI cards.
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
})
