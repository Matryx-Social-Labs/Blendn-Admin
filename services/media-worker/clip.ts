/**
 * What ffmpeg does with a downloaded clip: measure it, take stills, make two copies.
 *
 * The file is untrusted. `-f mov` forces the MP4/MOV reader, so a playlist that
 * names other files or addresses is never parsed, and `-protocol_whitelist file`
 * leaves nothing else to open. No shell; every run has a time limit.
 */
import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { join } from "node:path"

/** The web service's `MEDIA.MAX_CLIP_MS + CLIP_TOLERANCE_MS` (a test holds the two together). */
export const MAX_DURATION_MS = 15_500
/** A little over DCI 4K. Read from the container here and enforced on every decoded frame (`-max_pixels`): the two can differ. */
const MAX_PIXELS = 4096 * 2304
const SMALL_MAX_BYTES = 2_000_000
const MAIN_SIDE = 1080
const SMALL_SIDE = 540
const STEP_MS = 100_000
const STILL_MS = 15_000
const PROBE_MS = 20_000
export const STILLS = 6
const FIRST_STILL_SECONDS = 0.1

/** Before every input: what may be opened, and what decoding it may cost. */
const READ = ["-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-max_pixels", String(MAX_PIXELS), "-threads", "2"]
const INPUT = ["-nostdin", ...READ]

export class NotVideo extends Error {}

export interface ClipFacts {
  width: number
  height: number
  durationMs: number
  /** An HLG or PQ curve: its stills and copies are brought to SDR (`TO_SDR`). */
  hdr: boolean
}

/** HLG (iPhones record it by default) and PQ (HDR10, Dolby Vision 8.1). Not BT.2020 primaries or 10 bits alone: those can be SDR. */
const HDR_CURVES = new Set(["arib-std-b67", "smpte2084"])

export type Run = (tool: "ffmpeg" | "ffprobe", args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>

/**
 * Killed at its own limit, and when the job's signal says so; settles only once the process has gone, so the next job
 * never runs beside it. Not execFile's own `signal`: that sends SIGTERM whatever `killSignal` says, and settles at once.
 */
export const run: Run = (tool, args, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const stop = () => child.kill("SIGKILL")
    const child = execFile(tool, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      signal.removeEventListener("abort", stop)
      if (error) reject(error)
      else resolve(stdout)
    })
    signal.addEventListener("abort", stop, { once: true })
  })

interface Probe {
  streams?: { width?: number; height?: number; duration?: string; color_transfer?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[]
  format?: { duration?: string }
}

/** The size as displayed (rotation applied) and the length, from ffprobe's JSON; null when it is not a playable video. */
export function factsFrom(json: string): ClipFacts | null {
  let probe: Probe
  try {
    probe = JSON.parse(json) as Probe
  } catch {
    return null
  }
  const stream = probe.streams?.[0]
  const seconds = Number(probe.format?.duration ?? stream?.duration)
  if (!stream?.width || !stream.height || !(seconds > 0)) return null
  if (stream.width * stream.height > MAX_PIXELS) return null
  const rotation = stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(stream.tags?.rotate ?? 0)
  const turned = Math.abs(Math.round(rotation)) % 180 === 90
  return {
    width: turned ? stream.height : stream.width,
    height: turned ? stream.width : stream.height,
    durationMs: Math.round(seconds * 1000),
    hdr: HDR_CURVES.has(stream.color_transfer ?? ""),
  }
}

export async function probeClip(path: string, signal: AbortSignal, exec: Run = run): Promise<ClipFacts> {
  const json = await exec(
    "ffprobe",
    [...READ, "-select_streams", "v:0", "-show_entries",
      "stream=width,height,duration,color_transfer:stream_tags=rotate:stream_side_data=rotation:format=duration", "-of", "json", path],
    PROBE_MS,
    signal
  ).catch(() => "")
  signal.throwIfAborted()
  const facts = factsFrom(json)
  if (!facts) throw new NotVideo("not a playable video")
  return facts
}

/** When the stills are taken: the first frame (0.1 s, as the browser's poster), then five across the clip. */
export function stillTimes(durationMs: number): number[] {
  const seconds = durationMs / 1000
  return Array.from({ length: STILLS }, (_, i) =>
    i === 0 ? Math.min(FIRST_STILL_SECONDS, seconds / 2) : Number(((seconds * i) / STILLS).toFixed(2))
  )
}

/** Scales the short side down to `side` (never up) with even sides, as H.264 needs. */
export function scaleFilter(side: number): string {
  return `scale='if(gt(iw,ih),-2,trunc(min(${side},iw)/2)*2)':'if(gt(iw,ih),trunc(min(${side},ih)/2)*2,-2)'`
}

/**
 * HDR to SDR BT.709, in the pixels: the poster (a still) and the playing copy are then one picture on every device, where
 * a copy left tagged HLG is tone-mapped by each player and its still is not (decided per advisor 2026-11-25, task 32).
 * zscale reads the source's curve from the frame. Mobius rolls highlights off rather than clipping them. After the scale,
 * so the float frame is the small one.
 */
const TO_SDR = "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
const SDR_TAGS = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]

/** What every still and copy is drawn through: the scale, and the HDR clip's way to SDR. */
function picture(side: number, hdr: boolean): string {
  return hdr ? `${scaleFilter(side)},${TO_SDR}` : scaleFilter(side)
}

/** The small copy's bitrate: under the byte cap for its length, and never more than 540p can use. */
export function smallKbps(durationMs: number): number {
  return Math.min(1000, Math.floor((SMALL_MAX_BYTES * 8 * 0.85) / Math.max(durationMs, 1)))
}

const H264 = ["-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-profile:v", "high", "-fpsmax", "30", "-threads", "2", "-map_metadata", "-1", "-movflags", "+faststart"]

export interface Copy extends ClipFile {
  width: number
  height: number
}
export interface ClipFile {
  path: string
  bytes: number
}

export interface Still {
  path: string
  /** Seconds into the clip. */
  at: number
}

export interface ClipFiles {
  stills: Still[]
  main: Copy
  small: Copy
}

async function copy(path: string, signal: AbortSignal, exec: Run): Promise<Copy> {
  const { size } = await stat(path)
  const { width, height } = await probeClip(path, signal, exec)
  return { path, bytes: size, width, height }
}

export async function makeFiles(input: string, dir: string, facts: ClipFacts, signal: AbortSignal, exec: Run = run): Promise<ClipFiles> {
  const ffmpeg = (args: string[], timeoutMs = STEP_MS) => exec("ffmpeg", ["-y", ...INPUT, ...args], timeoutMs, signal)
  const limit = ["-t", String(MAX_DURATION_MS / 1000)]
  const tags = facts.hdr ? SDR_TAGS : []

  const stills: Still[] = []
  for (const [i, at] of stillTimes(facts.durationMs).entries()) {
    const path = join(dir, `still-${i}.jpg`)
    await ffmpeg(["-ss", String(at), "-i", input, "-frames:v", "1", "-vf", picture(MAIN_SIDE, facts.hdr), "-q:v", "3", "-update", "1", path], STILL_MS).catch((error: { killed?: boolean }) => {
      // A frame that cannot be read is left out; one that ran out of time ends the job.
      if (error.killed || signal.aborted) throw error
    })
    // A seek past the last frame writes nothing and still exits 0: that still is left out. The first one is the poster.
    const written = await stat(path).then((s) => s.size > 0, () => false)
    if (written) stills.push({ path, at })
    else if (i === 0) throw new NotVideo("no frame could be read")
  }

  const mainPath = join(dir, "main.mp4")
  await ffmpeg(["-i", input, ...limit, ...H264, "-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-crf", "22", "-maxrate", "6M", "-bufsize", "12M", "-vf", picture(MAIN_SIDE, facts.hdr), ...tags, mainPath])

  const smallPath = join(dir, "small.mp4")
  const small = (kbps: number) =>
    ffmpeg(["-i", input, ...limit, ...H264, "-an", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps}k`, "-vf", picture(SMALL_SIDE, facts.hdr), ...tags, smallPath])
  const kbps = smallKbps(facts.durationMs)
  await small(kbps)
  if ((await stat(smallPath)).size > SMALL_MAX_BYTES) await small(Math.floor(kbps * 0.7))

  return { stills, main: await copy(mainPath, signal, exec), small: await copy(smallPath, signal, exec) }
}
