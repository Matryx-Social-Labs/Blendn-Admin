"use client"

import { QRCodeSVG } from "qrcode.react"

/**
 * A scannable QR code for a URL, drawn as React SVG.
 *
 * The kit builds an SVG *string* and injects it with `dangerouslySetInnerHTML`.
 * Here the code is React elements from `qrcode.react` (no dependencies of its
 * own), so nothing is ever parsed as HTML whatever `value` contains.
 *
 * Dark modules on white, whatever the theme: a scanner needs the contrast, and
 * a QR code inverted for dark mode is one many phone cameras will not read.
 * The quiet zone is the standard's four modules (ISO/IEC 18004), drawn inside
 * the SVG (`marginSize`) so it scales with the code rather than being a fixed
 * 12px that falls short of four modules on a large one. Error correction "M", as
 * the kit uses — enough to survive a projector's glare or a crease in a print.
 *
 * Client-only because `qrcode.react` also ships a canvas variant that uses
 * state hooks, and the module is one file.
 */
export function QR({
  value,
  label,
  size = 180,
}: {
  value: string
  /**
   * What the code is for, e.g. "QR code to check in to Sunset Sessions".
   * Required: the URL itself is a poor name to read aloud, and a default
   * built from it would put the link in the accessibility tree twice.
   */
  label: string
  size?: number
}) {
  return (
    <div
      className="shrink-0 overflow-hidden rounded-panel bg-white"
      style={{ width: size, height: size }}
    >
      <QRCodeSVG
        value={value}
        level="M"
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#0d0c0c"
        role="img"
        aria-label={label}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </div>
  )
}
