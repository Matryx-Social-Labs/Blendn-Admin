/**
 * The worker's one request: `POST /clip`. The caller is the web service, over
 * the private network, with the shared secret. It sends the link and presigned
 * PUT URLs for what is made, so this process holds no storage keys at all.
 *
 * One job at a time; a short line waits, anything past it is told to come back.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

export interface Uploads {
  stills: string[]
  main: string
  small: string
}
export interface ClipRequest {
  url: string
  uploads: Uploads
}
export type ClipResult =
  | { ok: true; width: number; height: number; durationMs: number; stillSeconds: number[]; main: CopyFacts; small: CopyFacts }
  | { ok: false; reason: "unreachable" | "not_video" | "too_big" | "too_long"; bytes?: number; durationMs?: number }
export interface CopyFacts {
  width: number
  height: number
  bytes: number
}

const MAX_BODY = 32 * 1024
export const MAX_LINE = 3

const digest = (value: string) => createHash("sha256").update(value).digest()

export function authorised(header: string | undefined, secret: string): boolean {
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${secret}`))
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096

export function parseRequest(body: string): ClipRequest | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  const { url, uploads } = (value ?? {}) as Partial<ClipRequest>
  if (!isString(url) || !uploads || !isString(uploads.main) || !isString(uploads.small)) return null
  if (!Array.isArray(uploads.stills) || uploads.stills.length > 12 || !uploads.stills.every(isString)) return null
  return { url, uploads: { stills: uploads.stills, main: uploads.main, small: uploads.small } }
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export function createHandler(secret: string, job: (request: ClipRequest) => Promise<ClipResult>) {
  let waiting = 0
  let tail: Promise<unknown> = Promise.resolve()

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    try {
      if (request.method === "GET" && request.url === "/health") return send(200, { ok: true })
      if (request.method !== "POST" || request.url !== "/clip") return send(404, { error: "not found" })
      if (!authorised(request.headers.authorization, secret)) return send(401, { error: "unauthorised" })
      const body = await readBody(request)
      const parsed = body === null ? null : parseRequest(body)
      if (!parsed) return send(400, { error: "bad request" })
      if (waiting >= MAX_LINE) return send(503, { error: "busy" })

      waiting++
      const turn = tail.then(() => job(parsed))
      tail = turn.catch(() => undefined).finally(() => waiting--)
      send(200, await turn)
    } catch (error) {
      // Without any URL: the upload ones are presigned.
      console.error("clip job failed:", String(error).replace(/https?:\S+/g, "<url>").slice(0, 500))
      if (!response.headersSent) send(500, { error: "failed" })
    }
  }
}
