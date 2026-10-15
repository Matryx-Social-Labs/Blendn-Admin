import Image from "next/image"

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
 * uses 30px in the sidebar.
 */
const MARK = 30

export function BrandLogo() {
  return (
    <span className="flex items-center gap-2.5">
      <Image
        src="/brand/monogram-gradient.png"
        alt=""
        width={MARK}
        height={MARK}
        // The mark is the brand's first paint on every page; letting it arrive
        // late is the one image worth prioritising.
        priority
        style={{ width: MARK, height: MARK }}
      />
      <span className="font-bold text-base">Blend&apos;n</span>
    </span>
  )
}
