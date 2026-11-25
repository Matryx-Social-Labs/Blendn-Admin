import { randomUUID } from "crypto"

import { z } from "zod"

import { MEDIA } from "./constants"
import { logger } from "./logger"
import { getMaxFileSize } from "./upload-rules"
import { isConfigured, presignedPut } from "./tigris"

/**
 * Checking a clip with the media worker (SCRUM-1106, `services/media-worker`).
 *
 * The worker is a service of its own because it opens links people paste. It
 * holds no storage keys: this side signs a PUT URL for each file it may make,
 * and only those. Off while `MEDIA_WORKER_URL` or its secret is unset.
 */

export interface Rendition {
  url: string
  width: number
  height: number
  bytes: number
}

export interface CheckedClip {
  width: number
  height: number
  duration_ms: number
  /** Stills from the clip; the first is its opening frame. */
  stills: { url: string; at: number }[]
  /** Smallest first. */
  renditions: Rendition[]
}

export type ClipCheck =
  | { kind: "ok"; clip: CheckedClip }
  /** A verdict on the clip: it cannot be used as it is. */
  | { kind: "refused"; message: string }
  /** The worker could not be asked: says nothing about the clip. */
  | { kind: "unavailable" }

const STILLS = 6
/** Past a job's own limits and a short line in front of it. */
const ANSWER_MS = 240_000
const ATTEMPTS = 4
const RETRY_MS = 3_000
const WAKE_MS = 15_000

const worker = () => {
  const url = process.env.MEDIA_WORKER_URL?.trim()
  const secret = process.env.MEDIA_WORKER_SECRET?.trim()
  return url && secret ? { url: url.replace(/\/$/, ""), secret } : null
}

/** Whether clips are checked here: the editor draws none of it otherwise. */
export function clipCheckOn(): boolean {
  return worker() !== null
}

const side = z.number().int().min(1).max(MEDIA.MAX_SIDE_PX)
const copy = z.object({ width: side, height: side, bytes: z.number().int().min(1).max(getMaxFileSize("sponsored")) })
const answerSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    width: side,
    height: side,
    durationMs: z.number().int().min(1).max(MEDIA.MAX_CLIP_MS + MEDIA.CLIP_TOLERANCE_MS),
    stillSeconds: z.array(z.number().min(0)).min(1).max(STILLS),
    main: copy,
    small: copy,
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["unreachable", "not_video", "too_big", "too_long"]),
    bytes: z.number().optional(),
    durationMs: z.number().optional(),
  }),
])
type Answer = z.infer<typeof answerSchema>

const MB = 1024 * 1024

/** The refusal in words (decided per advisor 2026-11-25). */
export function refusalWords(answer: Extract<Answer, { ok: false }>): string {
  switch (answer.reason) {
    case "too_long":
      return `This clip is ${((answer.durationMs ?? 0) / 1000).toFixed(1)} seconds. Clips play up to ${MEDIA.MAX_CLIP_MS / 1000} seconds: trim it and add it again.`
    case "too_big":
      return `This clip is ${answer.bytes ? `${Math.ceil(answer.bytes / MB)} MB` : "over 50 MB"}. Clips can be up to 50 MB: export it smaller and add it again.`
    case "not_video":
      return "This link isn’t a video file. Paste a direct link to an MP4."
    case "unreachable":
      return "We couldn’t open this link. Check that it’s public, then paste it again."
  }
}

/** Asks the worker, waiting out its wake: a slept service refuses the connection or answers 502 first. */
async function ask(body: string, pause: (ms: number) => Promise<void>): Promise<Answer | null> {
  const target = worker()
  if (!target) return null
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const started = Date.now()
    try {
      const response = await fetch(`${target.url}/clip`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.secret}` },
        body,
        signal: AbortSignal.timeout(ANSWER_MS),
      })
      if (response.ok) return answerSchema.parse(await response.json())
      logger.warn("Media worker refused a clip check", { status: response.status, attempt })
      if (response.status !== 502) return null
    } catch (error) {
      logger.warn("Media worker did not answer", { attempt, error: error instanceof Error ? error.name : String(error) })
      // Only a connection that failed at once is asked again (the service is waking). A timeout, a bad answer or a
      // drop later on means a job ran: asking again would only run it again.
      if (!(error instanceof TypeError) || Date.now() - started > WAKE_MS) return null
    }
    if (attempt < ATTEMPTS) await pause(RETRY_MS)
  }
  return null
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * One check per person at a time, so nobody fills the worker's line. The editor
 * asks one by one; a second tab is told to come back.
 * ponytail: per process; a second web replica doubles it, which the worker's own line still bounds.
 */
const checking = new Set<string>()

export async function checkClip(url: string, userId: string, pause: (ms: number) => Promise<void> = wait): Promise<ClipCheck> {
  if (!clipCheckOn() || !isConfigured() || checking.has(userId)) return { kind: "unavailable" }
  checking.add(userId)
  try {
    return await checkNow(url, userId, pause)
  } finally {
    checking.delete(userId)
  }
}

async function checkNow(url: string, userId: string, pause: (ms: number) => Promise<void>): Promise<ClipCheck> {
  // Under the person's own events prefix, so it goes with their other uploads.
  const dir = `events/${userId}/clips/${randomUUID()}`
  const [main, small, ...stills] = await Promise.all([
    presignedPut(`${dir}/main.mp4`, "video/mp4"),
    presignedPut(`${dir}/small.mp4`, "video/mp4"),
    ...Array.from({ length: STILLS }, (_, i) => presignedPut(`${dir}/still-${i}.jpg`, "image/jpeg")),
  ])
  const answer = await ask(
    JSON.stringify({ url, uploads: { main: main.uploadUrl, small: small.uploadUrl, stills: stills.map((s) => s.uploadUrl) } }),
    pause
  )
  if (!answer) return { kind: "unavailable" }
  if (!answer.ok) return { kind: "refused", message: refusalWords(answer) }
  return {
    kind: "ok",
    clip: {
      width: answer.width,
      height: answer.height,
      duration_ms: answer.durationMs,
      stills: answer.stillSeconds.map((at, i) => ({ url: stills[i].publicUrl, at })),
      renditions: [
        { url: small.publicUrl, ...answer.small },
        { url: main.publicUrl, ...answer.main },
      ],
    },
  }
}
