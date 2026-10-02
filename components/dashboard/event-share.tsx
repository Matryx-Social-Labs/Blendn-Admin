"use client"

import { useEffect, useRef, useSyncExternalStore, type Ref } from "react"
import { createPortal } from "react-dom"
import {
  IconAlertTriangle,
  IconCopy,
  IconDownload,
  IconPresentation,
  IconPrinter,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { Panel } from "@/components/dashboard/kit"
import { QR } from "@/components/dashboard/qr-code"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** The downloaded PNG's side, exactly: sharp on an A4 door sign. */
const PNG_SIZE = 1024

/** How long a download's object URL outlives its click. Revoked sooner, some browsers save nothing. */
const REVOKE_AFTER_MS = 2_000

/**
 * The QR & link tab (step 15): the event's public address as a code for the
 * screen, a link to paste, files to hand a designer, and the door slide.
 *
 * Offered only to whoever runs a published event that is not a venue day
 * (`sharesLink`), so there is no draft or cancelled state to explain here.
 *
 * The slide is one element doing two jobs. "Full-screen slide" puts it on the
 * projector; "Print for the door" prints it and nothing else (the
 * `[data-door-slide]` rule in `app/globals.css`).
 */
export function EventShare({
  url,
  title,
  when,
  linksLive,
}: {
  /** `eventShareUrl(id)`, built on the server. Nothing else is ever encoded. */
  url: string
  title: string
  /** "4 Oct 2026, 15:31 · The Humming Tree", on the event's clock. */
  when: string
  /** `EVENT_LINKS_LIVE`: whether the address opens anything yet. */
  linksLive: boolean
}) {
  const slide = useRef<HTMLDivElement>(null)
  const presentButton = useRef<HTMLButtonElement>(null)
  const svgHolder = useRef<HTMLDivElement>(null)
  const name = fileName(title)
  // The portal needs `document`; on the server, and on the first client pass,
  // there is no slide until the page is hydrated.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false)

  // Leaving full screen — Esc, the browser's own control, the slide's Close —
  // puts focus back on the button that opened it.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) presentButton.current?.focus()
    }
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied")
    } catch {
      toast.error("Could not copy. Select the link and copy it.")
    }
  }

  function svgMarkup(): string | null {
    const svg = svgHolder.current?.querySelector("svg")
    if (!svg) return null
    const standalone = svg.cloneNode(true) as SVGSVGElement
    standalone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    standalone.setAttribute("width", String(PNG_SIZE))
    standalone.setAttribute("height", String(PNG_SIZE))
    return new XMLSerializer().serializeToString(standalone)
  }

  /*
   * Drawn on click, on a canvas that belongs to nothing, at exactly PNG_SIZE —
   * not a canvas kept mounted the whole time the tab is open, which
   * `qrcode.react` scales by the screen's pixel ratio (3072² on a phone, ~37 MB).
   */
  async function downloadPng() {
    const markup = svgMarkup()
    if (!markup) return
    const svgUrl = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }))
    try {
      const image = new Image()
      image.src = svgUrl
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = PNG_SIZE
      canvas.height = PNG_SIZE
      const context = canvas.getContext("2d")
      if (!context) throw new Error("no 2d context")
      // Modules stay square: no smoothing between them.
      context.imageSmoothingEnabled = false
      context.drawImage(image, 0, 0, PNG_SIZE, PNG_SIZE)
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
      if (!png) throw new Error("no PNG")
      save(png, `${name}.png`)
    } catch {
      toast.error("Could not make the PNG. Download the SVG instead.")
    } finally {
      URL.revokeObjectURL(svgUrl)
    }
  }

  function downloadSvg() {
    const markup = svgMarkup()
    if (markup) save(new Blob([markup], { type: "image/svg+xml" }), `${name}.svg`)
  }

  async function present() {
    try {
      await slide.current?.requestFullscreen()
      slide.current?.focus()
    } catch {
      toast.error("This browser would not go full screen. Print for the door instead.")
    }
  }

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-center gap-8">
          <div ref={svgHolder}>
            <QR value={url} label={`QR code for ${title}`} size={220} />
          </div>
          <div className="flex min-w-0 flex-1 basis-72 flex-col gap-3.5">
            <h2 className="text-[1.25rem] font-bold">Put this on the screen</h2>
            <p className="max-w-[52ch] text-sm leading-[22px] text-muted-foreground">
              Attendees scan it to find this event, check in with GPS inside your check-in area, and join the
              room under a made-up name.
            </p>
            {linksLive ? null : (
              <Note>
                The link does not open the app yet: phones show a &ldquo;not found&rdquo; page until blendn.app and
                the app learn event links. The address is permanent, so a code printed later will work; until then
                the slide and the print tell people to find the event by its name.
              </Note>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                readOnly
                value={url}
                aria-label="Event link"
                onFocus={(e) => e.currentTarget.select()}
                className="max-w-[360px] flex-1 basis-56 font-mono text-[0.8125rem] pointer-coarse:h-11"
              />
              <Button variant="outline" onClick={() => void copy()} className="pointer-coarse:h-11">
                <IconCopy aria-hidden className="size-4" />
                Copy
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void downloadPng()} className="pointer-coarse:h-11">
                <IconDownload aria-hidden className="size-4" />
                Download PNG
              </Button>
              <Button variant="outline" onClick={downloadSvg} className="pointer-coarse:h-11">
                <IconDownload aria-hidden className="size-4" />
                Download SVG
              </Button>
              <Button
                ref={presentButton}
                variant="outline"
                onClick={() => void present()}
                className="pointer-coarse:h-11"
              >
                <IconPresentation aria-hidden className="size-4" />
                Full-screen slide
              </Button>
              <Button variant="outline" onClick={() => window.print()} className="pointer-coarse:h-11">
                <IconPrinter aria-hidden className="size-4" />
                Print for the door
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      {/*
        The door slide, portalled to <body> so that printing can hide every
        other child of it, and so no container in the shell becomes its box.
      */}
      {mounted
        ? createPortal(
            <DoorSlide ref={slide} url={url} title={title} when={when} linksLive={linksLive} />,
            document.body
          )
        : null}
    </>
  )
}

/**
 * The slide itself: hidden until it is full screen or printed, and white
 * whatever the theme, because a projector and a printer both want it.
 *
 * A dialog while it fills the screen: named, focused when it opens, with a
 * Close for whoever cannot reach Esc. While the link opens nothing
 * (`EVENT_LINKS_LIVE`), it shows no code and no address — a door sign must not
 * send people to a dead page — and says to find the event by its name.
 */
export function DoorSlide({
  url,
  title,
  when,
  linksLive,
  ref,
}: {
  url: string
  title: string
  when: string
  linksLive: boolean
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={ref}
      data-door-slide=""
      role="dialog"
      aria-modal="true"
      aria-label={`Door slide for ${title}`}
      tabIndex={-1}
      className="relative hidden flex-col items-center justify-center gap-[3vmin] bg-white p-[5vmin] text-center text-black outline-none [&:fullscreen]:flex"
    >
      <p className="text-[5vmin] font-bold leading-tight">{title}</p>
      <p className="text-[2.6vmin]">{when}</p>
      {linksLive ? (
        <>
          <div className="aspect-square h-[60vmin]">
            <QR value={url} label={`QR code for ${title}`} fill />
          </div>
          <p className="text-[2.6vmin] font-bold">Scan to check in with Blend&apos;n</p>
          <p className="font-mono text-[1.8vmin]">{url}</p>
        </>
      ) : (
        <p className="max-w-[40ch] text-[3.4vmin] font-bold leading-snug">
          Open Blend&apos;n and find this event by its name to check in.
        </p>
      )}
      <button
        type="button"
        onClick={() => void document.exitFullscreen()}
        className="absolute right-[3vmin] top-[3vmin] rounded-md border border-black/20 px-4 py-2 text-base print:hidden"
      >
        Close
      </button>
    </div>
  )
}

const noSubscribe = () => () => {}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex max-w-[60ch] items-start gap-2 text-[0.8125rem] leading-5 text-muted-foreground">
      <IconAlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>{children}</span>
    </p>
  )
}

/** Hands a blob to the browser as a file: an anchor in the page, clicked, removed, the URL revoked later. */
function save(blob: Blob, download: string) {
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = download
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), REVOKE_AFTER_MS)
}

/** "Sunset Sessions at The Humming Tree" → "blendn-sunset-sessions-at-the-humming-tree-qr". */
export function fileName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return `blendn-${slug || "event"}-qr`
}
