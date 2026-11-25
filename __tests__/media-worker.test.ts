import { EventEmitter } from "events"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable, Writable } from "stream"
import { pipeline } from "stream/promises"

import { MEDIA } from "@/lib/constants"
import { MAX_DURATION_MS, STILLS, factsFrom, makeFiles, probeClip, run, scaleFilter, smallKbps, stillTimes, NotVideo } from "@/services/media-worker/clip"
import { capBytes, isPublicAddress, openableUrl, publicLookup } from "@/services/media-worker/fetch-clip"
import { JOB_MS, MAX_LINE, authorised, createHandler, parseRequest, type ClipResult } from "@/services/media-worker/handler"

/**
 * The clip worker (SCRUM-1106): it opens links people paste, so what it may
 * reach, how much it reads, and what it holds are the test.
 */

const DIR = join(__dirname, "../services/media-worker")

describe("what a pasted link may reach", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2002:a00:1::", "2001::1", "2001:db8::1",
    "", "example.com", "10.0.0.1.evil",
  ])("%s is not public", (address) => expect(isPublicAddress(address)).toBe(false))

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2a00:1450:4001::1"])("%s is public", (address) =>
    expect(isPublicAddress(address)).toBe(true)
  )

  it.each([
    "http://example.com/a.mp4", "file:///etc/passwd", "ftp://example.com/a", "data:video/mp4;base64,AA", "not a link",
    "https://user:pw@example.com/a.mp4", "https://example.com:8443/a.mp4", "https://127.0.0.1/a.mp4", "https://2130706433/a.mp4",
    "https://0x7f.1/a.mp4", "https://[::1]/a.mp4", "https://[::ffff:169.254.169.254]/latest", "https://[fd12::1]/",
  ])("%s is not opened", (link) => expect(openableUrl(link)).toBeNull())

  it("opens a public https link, and a relative redirect stays https", () => {
    expect(openableUrl("https://cdn.example.com/a.mp4")?.href).toBe("https://cdn.example.com/a.mp4")
    expect(openableUrl("/b.mp4", "https://cdn.example.com/a.mp4")?.href).toBe("https://cdn.example.com/b.mp4")
    expect(openableUrl("http://cdn.example.com/b.mp4", "https://cdn.example.com/a.mp4")).toBeNull()
  })

  const lookup = (addresses: string[], all: boolean) =>
    new Promise<{ error: Error | null; address: unknown }>((resolve) =>
      publicLookup((_host, done) => done(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))))(
        "cdn.example.com",
        { all },
        (error, address) => resolve({ error, address })
      )
    )

  it("checks the address it connects to, and one private address is enough to refuse the name", async () => {
    expect((await lookup(["93.184.216.34"], false)).address).toBe("93.184.216.34")
    expect((await lookup(["93.184.216.34"], true)).address).toEqual([{ address: "93.184.216.34", family: 4 }])
    expect((await lookup(["10.0.0.1"], false)).error).toBeInstanceOf(Error)
    expect((await lookup(["93.184.216.34", "fd12::1"], true)).error).toBeInstanceOf(Error)
    expect((await lookup([], true)).error).toBeInstanceOf(Error)
  })

  it("stops reading at the cap, whatever the answer claimed", async () => {
    const sink = () => new Writable({ write: (_chunk, _encoding, done) => done() })
    await expect(pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), capBytes(10), sink())).rejects.toMatchObject({ reason: "too_big" })
    await expect(pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(4)]), capBytes(10), sink())).resolves.toBeUndefined()
  })
})

describe("the clip", () => {
  const probe = (stream: object, duration = "12.0") => JSON.stringify({ streams: [stream], format: { duration } })

  it("is measured as displayed", () => {
    expect(factsFrom(probe({ width: 1920, height: 1080 }))).toEqual({ width: 1920, height: 1080, durationMs: 12_000 })
    expect(factsFrom(probe({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }))).toMatchObject({ width: 1080, height: 1920 })
    expect(factsFrom(probe({ width: 1920, height: 1080, tags: { rotate: "270" } }))).toMatchObject({ width: 1080, height: 1920 })
    expect(factsFrom(probe({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }))).toMatchObject({ width: 1920, height: 1080 })
  })

  it.each([["no video", JSON.stringify({ streams: [], format: { duration: "3" } })], ["no length", probe({ width: 10, height: 10 }, "N/A")], ["too many pixels", probe({ width: 8192, height: 8192 })], ["not JSON", "<html>"]])(
    "is not a video: %s",
    (_why, json) => expect(factsFrom(json)).toBeNull()
  )

  it("is refused at the dashboard's own limit", () => expect(MAX_DURATION_MS).toBe(MEDIA.MAX_CLIP_MS + MEDIA.CLIP_TOLERANCE_MS))

  it("gives six stills: the opening frame, then across the clip and inside it", () => {
    expect(stillTimes(12_000)).toEqual([0.1, 2, 4, 6, 8, 10])
    expect(stillTimes(150)[0]).toBeCloseTo(0.075)
    expect(stillTimes(150)).toHaveLength(STILLS)
  })

  it("keeps the small copy under 2 MB at every length", () => {
    for (const ms of [500, 5_000, 12_000, 15_500]) expect((smallKbps(ms) * 1000 * (ms / 1000)) / 8).toBeLessThanOrEqual(2_000_000 * 0.86)
    expect(smallKbps(500)).toBe(1000)
  })

  it("never scales up", () => expect(scaleFilter(540)).toContain("min(540,iw)"))

  it("never lets ffmpeg open anything but the file, as MP4", async () => {
    const runs: string[][] = []
    const exec = async (tool: "ffmpeg" | "ffprobe", args: string[]) => {
      runs.push([tool, ...args])
      return tool === "ffprobe" ? probe({ width: 1280, height: 720 }) : ""
    }
    const signal = new AbortController().signal
    await probeClip("/tmp/in", signal, exec)
    // No still is written by this fake, so it stops at the first: a clip with no poster is not a video.
    await expect(makeFiles("/tmp/in", "/tmp/no-such-dir", { width: 1280, height: 720, durationMs: 12_000 }, signal, exec)).rejects.toBeInstanceOf(NotVideo)
    for (const args of runs) {
      expect(args.join(" ")).toContain("-protocol_whitelist file -f mov -max_pixels 9437184 -threads 2")
      expect(args.indexOf("mov")).toBeLessThan(args.indexOf("/tmp/in"))
    }
    expect(runs.length).toBe(2)
  })

  it("ends the job when a still runs out of time or nobody is waiting, rather than trying the next", async () => {
    const facts = { width: 1280, height: 720, durationMs: 12_000 }
    const killed = jest.fn(() => Promise.reject(Object.assign(new Error("timed out"), { killed: true })))
    await expect(makeFiles("/tmp/in", "/tmp/no-such-dir", facts, new AbortController().signal, killed)).rejects.toThrow("timed out")
    expect(killed).toHaveBeenCalledTimes(1)
    const gone = new AbortController()
    gone.abort()
    await expect(probeClip("/tmp/in", gone.signal, () => Promise.reject(new Error("x")))).rejects.not.toBeInstanceOf(NotVideo)
  })

  it.each([["the job's signal", 20_000, true], ["its own limit", 1_500, false]])(
    "has no process left when it settles, even one that ignores SIGTERM: %s",
    async (_why, limit, abort) => {
      const pidFile = join(mkdtempSync(join(tmpdir(), "clip-run-")), "pid")
      const script = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
      const stop = new AbortController()
      const turn = run(process.execPath as never, ["-e", script], limit, stop.signal)
      const settled = expect(turn).rejects.toThrow()
      if (abort) {
        while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) await new Promise((resolve) => setTimeout(resolve, 20))
        stop.abort()
      }
      await settled
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow(/ESRCH/)
    },
    15_000
  )

  it("starts nothing for a job that is already over", async () => {
    await expect(run("ffmpeg", ["-version"], 1_000, AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone")
  })
})

describe("the request", () => {
  const SECRET = "s".repeat(40)
  const good = JSON.stringify({ url: "https://cdn.example.com/a.mp4", uploads: { main: "https://m", small: "https://s", stills: ["https://0"] } })
  const done: ClipResult = { ok: false, reason: "not_video" }

  async function send(handler: ReturnType<typeof createHandler>, opts: { method?: string; url?: string; auth?: string; body?: string; onResponse?: (response: EventEmitter) => void } = {}) {
    const request = Object.assign(Readable.from([Buffer.from(opts.body ?? good)]), {
      method: opts.method ?? "POST",
      url: opts.url ?? "/clip",
      headers: { authorization: opts.auth ?? `Bearer ${SECRET}` },
    })
    const response = Object.assign(new EventEmitter(), {
      status: 0,
      body: "",
      headersSent: false,
      writeHead(status: number) {
        this.status = status
        this.headersSent = true
      },
      end(body: string) {
        this.body = body
      },
    })
    opts.onResponse?.(response)
    await handler(request as never, response as never)
    return response.status
  }

  it("needs the secret", async () => {
    expect(authorised(`Bearer ${SECRET}`, SECRET)).toBe(true)
    for (const auth of [undefined, "", SECRET, "Bearer ", `Bearer ${SECRET}x`]) expect(authorised(auth, SECRET)).toBe(false)
    const job = jest.fn(async () => done)
    expect(await send(createHandler(SECRET, job), { auth: "Bearer wrong" })).toBe(401)
    expect(job).not.toHaveBeenCalled()
  })

  it.each(["", "{}", "null", "[]", JSON.stringify({ url: 1, uploads: {} }), JSON.stringify({ url: "https://a", uploads: { main: "m", small: "s", stills: Array(13).fill("x") } }), JSON.stringify({ url: "https://a".padEnd(5000, "a"), uploads: { main: "m", small: "s", stills: [] } }), "x".repeat(40_000)])(
    "refuses a bad body",
    async (body) => expect(await send(createHandler(SECRET, async () => done), { body })).toBe(400)
  )

  it("answers health without the secret, and nothing else", async () => {
    const handler = createHandler(SECRET, async () => done)
    expect(await send(handler, { method: "GET", url: "/health", auth: "" })).toBe(200)
    expect(await send(handler, { method: "GET" })).toBe(404)
  })

  it("runs one job at a time, keeps a short line, and goes on after a failure", async () => {
    let running = 0
    let most = 0
    const releases: (() => void)[] = []
    const job = jest.fn(async () => {
      most = Math.max(most, ++running)
      await new Promise<void>((resolve) => releases.push(resolve))
      running--
      if (job.mock.calls.length === 1) throw new Error("boom https://signed.example/?X-Amz-Signature=abc")
      return done
    })
    const log = jest.spyOn(console, "error").mockImplementation(() => {})
    const handler = createHandler(SECRET, job)
    const line = Array.from({ length: MAX_LINE }, () => send(handler))
    await new Promise((resolve) => setImmediate(resolve))
    expect(await send(handler)).toBe(503)
    const statuses: number[] = []
    for (const turn of line) {
      while (releases.length === 0) await new Promise((resolve) => setImmediate(resolve))
      releases.shift()!()
      statuses.push(await turn)
    }
    expect(statuses).toEqual([500, 200, 200])
    expect(most).toBe(1)
    expect(log.mock.calls.flat().join(" ")).not.toContain("Signature")
    // The line is empty again.
    const next = send(handler)
    while (releases.length === 0) await new Promise((resolve) => setImmediate(resolve))
    releases.shift()!()
    expect(await next).toBe(200)
    log.mockRestore()
  })

  it("skips a queued job and stops a running one when its caller has gone", async () => {
    const log = jest.spyOn(console, "error").mockImplementation(() => {})
    const signals: AbortSignal[] = []
    const handler = createHandler(SECRET, (_request, signal) => {
      signals.push(signal)
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
    })
    const responses: EventEmitter[] = []
    const line = [send(handler, { onResponse: (r) => responses.push(r) }), send(handler, { onResponse: (r) => responses.push(r) })]
    while (signals.length === 0) await new Promise((resolve) => setImmediate(resolve))
    responses[1].emit("close")
    responses[0].emit("close")
    await Promise.all(line)
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
    log.mockRestore()
  })

  it("gives one job less time than its caller waits", () => expect(JOB_MS).toBeLessThan(240_000))

  it("takes only what it knows", () => expect(parseRequest(good)).toEqual(JSON.parse(good)))
})

describe("what the service holds", () => {
  const sources = readdirSync(DIR).filter((f) => /\.(ts|mjs)$/.test(f))
  const text = (f: string) => readFileSync(join(DIR, f), "utf8")

  it("reads its secret and its port, and no other variable", () => {
    const read = sources.flatMap((f) => [...text(f).matchAll(/process\.env(?:\.(\w+)|\W)/g)].map((m) => m[1] ?? "(whole env)"))
    expect(new Set(read)).toEqual(new Set(["MEDIA_WORKER_SECRET", "PORT"]))
  })

  it("has no dependencies and imports only node and itself", () => {
    const pkg = JSON.parse(text("package.json"))
    expect(pkg.dependencies ?? pkg.devDependencies).toBeUndefined()
    const imports = sources.flatMap((f) => [...text(f).matchAll(/from "([^"]+)"/g)].map((m) => m[1]))
    expect(imports.length).toBeGreaterThan(5)
    for (const from of imports) expect(from).toMatch(/^(node:|\.\/)/)
  })

  it("starts itself from its own Dockerfile, as a plain user, with every source in the image", () => {
    const docker = text("Dockerfile")
    expect(docker).toMatch(/^CMD \["node", "main\.mjs"\]$/m)
    expect(docker).toMatch(/^USER node$/m)
    const copied = /^COPY (.+) \.\/$/m.exec(docker)![1].split(" ")
    expect(new Set(copied)).toEqual(new Set([...sources, "package.json"]))
    expect(docker.replace(/^#.*$/gm, "")).not.toMatch(/prisma|migrate|server\.js|npm/)
    expect(readdirSync(DIR).filter((f) => /^railway\./.test(f))).toEqual([])
  })
})
