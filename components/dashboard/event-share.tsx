"use client"

import { useRef, useSyncExternalStore, type Ref } from "react"
import { createPortal } from "react-dom"
import { QRCodeCanvas } from "qrcode.react"
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

/** Large enough to print an A4 door sign sharp; the screen copy is SVG anyway. */
const PNG_SIZE = 1024

/**
 * The QR & link tab (step 15): the event's public address as a code for the
 * screen, a link to paste, files to hand a designer, and the door slide.
 *
 * The slide is one element doing two jobs. "Full-screen slide" puts it on the
 * projector; "Print for the door" prints it and nothing else (the
 * `[data-door-slide]` rule in `app/globals.css`). Both are the same title, the
 * same when and where, and the code at the size of the page.
 */
export function EventShare({
  url,
  title,
  when,
  status,
  linksLive,
}: {
  /** `eventShareUrl(id)`, built on the server. Nothing else is ever encoded. */
  url: string
  title: string
  /** "Sat 4 Oct, 15:31 · The Humming Tree", on the event's clock. */
  when: string
  status: "draft" | "published" | "cancelled" | "completed"
  /** `EVENT_LINKS_LIVE`: whether the address opens anything yet. */
  linksLive: boolean
}) {
  const slide = useRef<HTMLDivElement>(null)
  const svgHolder = useRef<HTMLDivElement>(null)
  const canvasHolder = useRef<HTMLDivElement>(null)
  const name = fileName(title)
  // The portal needs `document`; on the server, and on the first client pass,
  // there is no slide until the page is hydrated.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied")
    } catch {
      toast.error("Could not copy. Select the link and copy it.")
    }
  }

  function downloadPng() {
    const canvas = canvasHolder.current?.querySelector("canvas")
    if (!canvas) return
    save(canvas.toDataURL("image/png"), `${name}.png`)
  }

  function downloadSvg() {
    const svg = svgHolder.current?.querySelector("svg")
    if (!svg) return
    const copy = svg.cloneNode(true) as SVGSVGElement
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    copy.setAttribute("width", String(PNG_SIZE))
    copy.setAttribute("height", String(PNG_SIZE))
    const href = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }))
    save(href, `${name}.svg`)
    // After the click has handed the blob to the download, not before.
    setTimeout(() => URL.revokeObjectURL(href), 0)
  }

  async function present() {
    try {
      await slide.current?.requestFullscreen()
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
            {status === "draft" ? (
              <Note>Nobody can open this event until it is published. The code and the link stay the same after.</Note>
            ) : status === "cancelled" ? (
              <Note>This event is cancelled. Anyone who scans the code will be told so.</Note>
            ) : null}
            {linksLive ? null : (
              <Note>
                The link does not open the app yet: phones show a &ldquo;not found&rdquo; page until blendn.app and
                the app learn event links. The address is permanent, so a code printed now starts working then.
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
              <Button onClick={downloadPng} className="pointer-coarse:h-11">
                <IconDownload aria-hidden className="size-4" />
                Download PNG
              </Button>
              <Button variant="outline" onClick={downloadSvg} className="pointer-coarse:h-11">
                <IconDownload aria-hidden className="size-4" />
                Download SVG
              </Button>
              <Button variant="outline" onClick={() => void present()} className="pointer-coarse:h-11">
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

      {/* The PNG's source: drawn off screen at print size, never shown. */}
      <div ref={canvasHolder} hidden>
        <QRCodeCanvas value={url} size={PNG_SIZE} level="M" marginSize={4} bgColor="#ffffff" fgColor="#0d0c0c" />
      </div>

      {/*
        The door slide, portalled to <body> so that printing can hide every
        other child of it, and so no container in the shell becomes its box.
      */}
      {mounted ? createPortal(<DoorSlide ref={slide} url={url} title={title} when={when} linksLive={linksLive} />, document.body) : null}
    </>
  )
}

/**
 * The slide itself: hidden until it is full screen or printed, and white
 * whatever the theme, because a projector and a printer both want it.
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
      className="hidden flex-col items-center justify-center gap-[3vmin] bg-white p-[5vmin] text-center text-black [&:fullscreen]:flex"
    >
      <p className="text-[5vmin] font-bold leading-tight">{title}</p>
      <p className="text-[2.6vmin]">{when}</p>
      <div className="aspect-square h-[60vmin]">
        <QR value={url} label={`QR code for ${title}`} fill />
      </div>
      {/* A door sign must not send people to a page that is not there yet. */}
      <p className="text-[2.6vmin] font-bold">
        {linksLive ? "Scan to check in with Blend'n" : "Check in with the Blend'n app: find this event by its name"}
      </p>
      <p className="font-mono text-[1.8vmin]">{url}</p>
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

function save(href: string, download: string) {
  const a = document.createElement("a")
  a.href = href
  a.download = download
  a.click()
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
