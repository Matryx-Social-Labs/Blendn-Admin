/**
 * The log archive (SCRUM-1497, register D-041): an hourly job copies the web
 * service's stdout from Railway into gzipped NDJSON in the PRIVATE bucket
 * (kept 180 days, CERT-In) and then into Axiom (searchable 30 days).
 *
 * It runs as its own cron service, outside the web process, so a sink that is
 * down can fail the job's run but never a request (last test).
 */
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { gunzipSync } from "zlib"

process.env.TIGRIS_ENDPOINT = "https://t3.storage.dev"
process.env.TIGRIS_ACCESS_KEY = "test"
process.env.TIGRIS_SECRET_KEY = "test"
process.env.TIGRIS_BUCKET = "blendn-media-test"
const PRIVATE = "blendn-media-test-private"

type Sent = { name: string; input: Record<string, unknown>; options?: { abortSignal?: unknown } }
const sent: Sent[] = []
let existing: string[] = []

jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }))
jest.mock("@aws-sdk/client-s3", () => {
  const cmd = (name: string) =>
    class {
      readonly name = name
      constructor(public readonly input: Record<string, unknown>) {}
    }
  return {
    S3Client: class {
      async send(command: Sent, options?: Sent["options"]) {
        sent.push({ name: command.name, input: command.input, options })
        if (command.name === "ListObjectsV2") {
          const prefix = command.input.Prefix as string
          return { Contents: existing.filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })), IsTruncated: false }
        }
        return {}
      }
    },
    ...Object.fromEntries(
      ["CopyObject", "GetObject", "HeadObject", "PutObject", "DeleteObject", "DeleteObjects", "ListObjectsV2", "CreateBucket", "HeadBucket", "PutBucketCors", "PutBucketPolicy"].map(
        (n) => [`${n}Command`, cmd(n)]
      )
    ),
  }
})

import { archiveLogs } from "../scripts/log-archive"

const NOW = new Date("2026-11-27T10:17:00Z")
const HOUR = "2026-11-27T09:00:00.000Z"

type Row = { timestamp: string; message: string; severity: string; attributes: { key: string; value: string }[] }
const row = (timestamp: string, message: string, attrs: Record<string, unknown> = {}): Row => ({
  timestamp,
  message,
  severity: "info",
  attributes: [
    { key: "level", value: '"info"' },
    { key: "timestamp", value: JSON.stringify(timestamp) },
    ...Object.entries(attrs).map(([key, v]) => ({ key, value: JSON.stringify(v) })),
  ],
})

let logs: Record<string, Row[]> = {}
let deployments: { id: string; status: string; createdAt: string }[] = []
let axiom: "up" | "down" = "up"
const calls: { url: string; body: string; headers: Record<string, string>; signal: unknown }[] = []
const PAGE = 5000

beforeEach(() => {
  sent.length = 0
  calls.length = 0
  existing = []
  axiom = "up"
  deployments = [
    { id: "dep-new", status: "SUCCESS", createdAt: "2026-11-27T09:30:00Z" },
    { id: "dep-old", status: "REMOVED", createdAt: "2026-11-20T00:00:00Z" },
    { id: "dep-failed", status: "FAILED", createdAt: "2026-11-27T09:20:00Z" },
    { id: "dep-later", status: "SUCCESS", createdAt: "2026-11-27T10:05:00Z" },
  ]
  logs = {
    "dep-old": [row("2026-11-27T08:59:59.999Z", "before the hour"), row("2026-11-27T09:10:00.5Z", "old one", { userId: "u1" }), row("2026-11-27T09:31:00Z", "old draining")],
    "dep-new": [row("2026-11-27T09:30:30.123456789Z", "new one", { eventsCount: 3 }), row("2026-11-27T10:00:00Z", "next hour")],
    "dep-failed": [row("2026-11-27T09:21:00Z", "boot failed")],
  }
  process.env.RAILWAY_ENVIRONMENT_NAME = "staging"
  process.env.RAILWAY_PROJECT_ID = "proj"
  process.env.RAILWAY_ENVIRONMENT_ID = "envid"
  process.env.LOGS_SERVICE_ID = "svc"
  process.env.RAILWAY_LOGS_PROJECT_TOKEN = "rw-test"
  process.env.AXIOM_TOKEN = "ax-test"
  process.env.AXIOM_DATASET = "blendn-logs"
  global.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "")
    calls.push({ url: String(url), body, headers: init?.headers as Record<string, string>, signal: init?.signal })
    if (String(url).includes("axiom")) {
      if (axiom === "down") return new Response("unavailable", { status: 503 })
      return Response.json({ ingested: body.split("\n").filter(Boolean).length, failed: 0 })
    }
    const { query, variables } = JSON.parse(body)
    if (query.includes("deployments(")) return Response.json({ data: { deployments: { edges: deployments.map((node) => ({ node })) } } })
    const from = Date.parse(variables.startDate)
    const to = Date.parse(variables.endDate)
    // Railway's endDate is inclusive, and a full page is the newest `limit` lines of the window (measured on staging).
    // A time Railway reads and JS cannot (the garbled-line test) comes back whatever the window.
    const inWindow = (logs[variables.deploymentId] ?? []).filter((r) => {
      const t = Date.parse(r.timestamp)
      return Number.isNaN(t) || (t >= from && t <= to)
    })
    return Response.json({ data: { deploymentLogs: inWindow.slice(-variables.limit) } })
  }) as unknown as typeof fetch
})

const puts = () => sent.filter((c) => c.name === "PutObject")
const archived = (key: string) =>
  gunzipSync(puts().find((c) => c.input.Key === key)!.input.Body as Buffer)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const axiomBodies = () => calls.filter((c) => c.url.includes("axiom"))

describe("archiveLogs", () => {
  it("writes one whole UTC hour, from every deployment that served in it, to the private bucket, then to Axiom", async () => {
    existing = Array.from({ length: 48 }, (_, i) => new Date(Date.parse(HOUR) - i * 3_600_000).toISOString())
      .filter((h) => h !== HOUR)
      .map((h) => `logs/staging/${h.slice(0, 10)}/${h.slice(11, 13)}.ndjson.gz`)

    const result = await archiveLogs(NOW)

    expect(result).toEqual({ written: [{ key: "logs/staging/2026-11-27/09.ndjson.gz", lines: 4 }], failures: [] })
    expect(puts()).toHaveLength(1)
    expect(puts()[0].input).toMatchObject({ Bucket: PRIVATE, Key: "logs/staging/2026-11-27/09.ndjson.gz" })
    const lines = archived("logs/staging/2026-11-27/09.ndjson.gz")
    // In time order across deployments; the hour is half-open, so 08:59:59.999 and 10:00:00 are not in it.
    // A FAILED deployment's boot output is kept: it is what a bad deploy is read from.
    expect(lines.map((l) => l.message)).toEqual(["old one", "boot failed", "new one", "old draining"])
    expect(lines[0]).toEqual({
      _time: "2026-11-27T09:10:00.5Z",
      env: "staging",
      level: "info",
      message: "old one",
      deploymentId: "dep-old",
      attributes: JSON.stringify({ userId: "u1" }),
    })
    // A deployment created after the hour is not asked.
    expect(calls.some((c) => c.body.includes("dep-later"))).toBe(false)
    // Railway is asked with the project token, and every call carries a deadline.
    expect(calls[0].headers["Project-Access-Token"]).toBe("rw-test")
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true)
    expect(sent.every((c) => c.options?.abortSignal instanceof AbortSignal)).toBe(true)
    // Axiom gets the same lines, after the archive.
    const [ax] = axiomBodies()
    expect(ax.url).toBe("https://us-east-1.aws.edge.axiom.co/v1/ingest/blendn-logs")
    expect(ax.headers.authorization).toBe("Bearer ax-test")
    expect(ax.body.split("\n").filter(Boolean).map((l) => JSON.parse(l))).toEqual(lines)
  })

  it("fills every missing hour of the last 48, and sends Axiom only the hours it wrote", async () => {
    existing = ["logs/staging/2026-11-27/08.ndjson.gz"]

    const result = await archiveLogs(NOW)

    expect(result.failures).toEqual([])
    expect(result.written).toHaveLength(47)
    expect(puts().map((c) => c.input.Key)).not.toContain("logs/staging/2026-11-27/08.ndjson.gz")
    // An empty hour is written too, so it is not fetched again on every run.
    expect(result.written).toContainEqual({ key: "logs/staging/2026-11-25/10.ndjson.gz", lines: 0 })
    // Only hours with lines reach Axiom.
    expect(axiomBodies()).toHaveLength(1)
  })

  it("halves a window whose page came back full, so nothing is cut off", async () => {
    existing = []
    logs["dep-new"] = Array.from({ length: PAGE + 10 }, (_, i) => row(new Date(Date.parse("2026-11-27T09:30:00Z") + i * 100).toISOString(), `line ${i}`))
    deployments = [deployments[0]]

    const result = await archiveLogs(NOW, HOUR)

    expect(result.written).toEqual([{ key: "logs/staging/2026-11-27/09.ndjson.gz", lines: PAGE + 10 }])
    const lines = archived("logs/staging/2026-11-27/09.ndjson.gz")
    expect(new Set(lines.map((l) => l.message)).size).toBe(PAGE + 10)
  })

  it("keeps the archive when Axiom is down, and fails the run instead of saying nothing", async () => {
    axiom = "down"

    const result = await archiveLogs(NOW, HOUR)

    expect(puts().map((c) => c.input.Key)).toEqual(["logs/staging/2026-11-27/09.ndjson.gz"])
    expect(result.failures).toEqual([expect.stringMatching(/^2026-11-27T09:00:00.000Z: archived, not in Axiom: Axiom 503/)])
  })

  it("archives without Axiom while neither Axiom variable is set, and says so; one without the other fails", async () => {
    delete process.env.AXIOM_TOKEN
    delete process.env.AXIOM_DATASET

    const result = await archiveLogs(NOW, HOUR)

    expect(result).toEqual({ written: [{ key: "logs/staging/2026-11-27/09.ndjson.gz", lines: 4 }], failures: [], axiom: "not configured" })
    expect(axiomBodies()).toHaveLength(0)

    process.env.AXIOM_DATASET = "blendn-logs"
    sent.length = 0
    const half = await archiveLogs(NOW, HOUR)
    // Refused before anything is read or written.
    expect(half.failures).toEqual([expect.stringMatching(/AXIOM_TOKEN is not set/)])
    expect(sent).toHaveLength(0)
  })

  it("fails the hour, and writes nothing for it, when Railway refuses", async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async () => Response.json({ errors: [{ message: "Not Authorized" }] }))

    const result = await archiveLogs(NOW, HOUR)

    expect(puts()).toHaveLength(0)
    expect(result.failures).toEqual([expect.stringMatching(/Not Authorized/)])
  })

  it("reads an hour only once it is ten minutes past", async () => {
    existing = Array.from({ length: 48 }, (_, i) => new Date(Date.parse(HOUR) - (i + 1) * 3_600_000).toISOString()).map(
      (h) => `logs/staging/${h.slice(0, 10)}/${h.slice(11, 13)}.ndjson.gz`
    )
    expect((await archiveLogs(new Date("2026-11-27T10:09:00Z"))).written).toEqual([])
    expect((await archiveLogs(new Date("2026-11-27T10:10:00Z"))).written).toEqual([{ key: "logs/staging/2026-11-27/09.ndjson.gz", lines: 4 }])
  })

  it("fails an hour, and writes nothing for it, when it cannot see which deployment served its start", async () => {
    // A wrong LOGS_SERVICE_ID: Railway answers an empty list, not an error.
    deployments = []
    const none = await archiveLogs(NOW, HOUR)
    expect(none.failures).toEqual([expect.stringMatching(/^2026-11-27T09:00:00.000Z: no deployment of LOGS_SERVICE_ID/)])

    // Five deploys inside the hour: the one live at its start is past the five asked.
    deployments = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, status: "SUCCESS", createdAt: `2026-11-27T09:1${i}:00Z` })).concat([
      { id: "dep-old", status: "REMOVED", createdAt: "2026-11-20T00:00:00Z" },
    ])
    const busy = await archiveLogs(NOW, HOUR)
    expect(busy.failures).toEqual([expect.stringMatching(/^2026-11-27T09:00:00.000Z: no deployment of LOGS_SERVICE_ID/)])
    expect(puts()).toHaveLength(0)
  })

  it("never overwrites an hour with nothing when it is asked again after Railway has dropped it", async () => {
    logs = {}
    const result = await archiveLogs(NOW, HOUR)
    expect(result.failures).toEqual([expect.stringMatching(/Railway has no lines for this hour/)])
    expect(puts()).toHaveLength(0)
  })

  it("fails a line whose time it cannot read, instead of dropping it", async () => {
    logs["dep-new"].push(row("not a time", "garbled"))
    const result = await archiveLogs(NOW, HOUR)
    expect(result.failures).toEqual([expect.stringMatching(/unreadable timestamp/)])
    expect(puts()).toHaveLength(0)
  })

  it("never sends the Axiom token to a host that is not Axiom", async () => {
    process.env.AXIOM_DOMAIN = "axiom.co.example.com"
    const result = await archiveLogs(NOW, HOUR)
    delete process.env.AXIOM_DOMAIN
    expect(result.failures).toEqual([expect.stringMatching(/AXIOM_DOMAIN/)])
    expect(calls).toHaveLength(0)
  })

  it("never writes to the public bucket", async () => {
    await archiveLogs(NOW)
    expect(puts().length).toBeGreaterThan(0)
    expect(puts().every((c) => c.input.Bucket === PRIVATE)).toBe(true)
  })

  it("is not imported by the web service, so a sink that is down cannot touch a request", () => {
    const root = join(__dirname, "..")
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
      })
    const web = [...files(join(root, "app")), ...files(join(root, "lib")), join(root, "server.ts"), join(root, "middleware.ts")]
    expect(web.filter((f) => readFileSync(f, "utf8").includes("log-archive"))).toEqual([])
  })
})
