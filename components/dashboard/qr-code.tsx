"use client"

import { QRCodeSVG } from "qrcode.react"

/**
 * A scannable QR code for a URL, drawn as React SVG.
 *
 * The kit builds an SVG *string* and injects it with `dangerouslySetInnerHTML`.
 * Here the code is React elements from `qrcode.react` (no dependencies of its
 * own), so nothing is ever parsed as HTML whatever `value` contains.
 *
 * Dark modules on a white tile with 12px of padding, whatever the theme: a
 * scanner needs the contrast and the quiet zone, and a QR code inverted for
 * dark mode is one many phone cameras will not read. Error correction "M", as
 * the kit uses — enough to survive a projector's glare or a crease in a print.
 *
 * Client-only because `qrcode.react` also ships a canvas variant that uses
 * state hooks, and the module is one file.
 */
export function QR({ value, size = 180, label }: { value: string; size?: number; label?: string }) {
  return (
    <div
      className="shrink-0 rounded-panel bg-white p-3"
      style={{ width: size, height: size }}
    >
      <QRCodeSVG
        value={value}
        level="M"
        bgColor="#ffffff"
        fgColor="#0d0c0c"
        role="img"
        aria-label={label ?? `QR code for ${value}`}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </div>
  )
}
