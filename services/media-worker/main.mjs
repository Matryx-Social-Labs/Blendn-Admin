import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FetchRefusal, fetchClip } from "./fetch-clip.ts"
import { MAX_DURATION_MS, NotVideo, makeFiles, probeClip } from "./clip.ts"
import { createHandler } from "./handler.ts"

const secret = process.env.MEDIA_WORKER_SECRET ?? ""
if (secret.length < 32) throw new Error("MEDIA_WORKER_SECRET must be set, 32 characters or more")

const UPLOAD_MS = 30_000

async function put(url, path, type) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": type },
    body: await readFile(path),
    redirect: "error",
    signal: AbortSignal.timeout(UPLOAD_MS),
  })
  if (!response.ok) throw new Error(`upload answered ${response.status}`)
}

async function job({ url, uploads }) {
  const dir = await mkdtemp(join(tmpdir(), "clip-"))
  try {
    const input = join(dir, "input")
    await fetchClip(url, input)
    const facts = await probeClip(input)
    if (facts.durationMs > MAX_DURATION_MS) return { ok: false, reason: "too_long", durationMs: facts.durationMs }
    const { stills, main, small } = await makeFiles(input, dir, facts)
    const taken = stills.slice(0, uploads.stills.length)
    await Promise.all([
      ...taken.map(({ path }, i) => put(uploads.stills[i], path, "image/jpeg")),
      put(uploads.main, main.path, "video/mp4"),
      put(uploads.small, small.path, "video/mp4"),
    ])
    const copyFacts = ({ width, height, bytes }) => ({ width, height, bytes })
    return { ok: true, ...facts, stillSeconds: taken.map((s) => s.at), main: copyFacts(main), small: copyFacts(small) }
  } catch (error) {
    if (error instanceof FetchRefusal) return { ok: false, reason: error.reason, bytes: error.bytes }
    if (error instanceof NotVideo) return { ok: false, reason: "not_video" }
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// "::" so the private network (IPv6 on Railway) reaches it.
createServer(createHandler(secret, job)).listen(Number(process.env.PORT ?? 8080), "::")
