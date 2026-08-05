import Image from "next/image"

import { cn } from "@/lib/utils"

/**
 * The brand mark, placed as the design places it.
 *
 * The design uses the monogram at a fixed square size next to the word
 * "Blend'n" set in the UI font at 700 — not an image of the full lockup inside
 * a rounded white plate, which is what this component used to render. That
 * plate existed to stop a non-transparent PNG showing a white box on a dark
 * background; the assets are transparent now, so the plate is not needed and
 * its rounded pill was reading as a button.
 *
 * Setting the wordmark as text rather than shipping it as an image also means
 * it inherits Satoshi, sits on the same baseline grid as everything else, and
 * stays crisp at any zoom.
 *
 * The guideline's 35px minimum height applies to the *logo lockup* as an
 * artwork; the monogram alone in UI chrome is a different case, and the design
 * uses 30px in the sidebar and 26px in the mobile header.
 */
const SIZES = {
  /** Sidebar header. */
  sidebar: { mark: 30, text: "text-base" },
  /** Compact chrome — mobile header. */
  header: { mark: 26, text: "text-[0.9375rem]" },
  /** Login and other full-page contexts. */
  hero: { mark: 44, text: "text-2xl" },
} as const

export function BrandLogo({
  size = "sidebar",
  /** Monogram only — for the collapsed sidebar. */
  markOnly = false,
  className,
}: {
  size?: keyof typeof SIZES
  markOnly?: boolean
  className?: string
}) {
  const { mark, text } = SIZES[size]

  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <Image
        src="/brand/monogram-gradient.png"
        alt={markOnly ? "Blend'n" : ""}
        width={mark}
        height={mark}
        // The mark is the brand's first paint on every page; letting it arrive
        // late is the one image worth prioritising.
        priority
        style={{ width: mark, height: mark }}
      />
      {markOnly ? null : (
        <span className={cn("font-bold leading-none", text)}>Blend&apos;n</span>
      )}
    </span>
  )
}
