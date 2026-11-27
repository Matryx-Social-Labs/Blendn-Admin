import { PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"
import { gzipSync } from "zlib"

import { bucketFor, getS3Client } from "../lib/tigris"

/**
 * The log archive (SCRUM-1497, register D-041). Run hourly as its own Railway
 * cron service per environment (`5 * * * *`), never inside the web service:
 *
 *   npx tsx scripts/log-archive.ts                     every missing hour of the last 48
 *   npx tsx scripts/log-archive.ts 2026-11-27T09       that hour again (archive and Axiom)
 *
 * Railway has no log drain, so this reads the web service's stdout back
 * through Railway's API (`deploymentLogs`), one whole UTC hour at a time, and
 * writes it as gzipped NDJSON to the PRIVATE bucket under
 * `logs/<env>/<YYYY-MM-DD>/<HH>.ndjson.gz` (a lifecycle rule removes it after
 * 180 days: DEPLOYMENT.md, Logs) and then posts the same lines to Axiom (30
 * days, searchable). The archive is written first, so an Axiom outage never
 * costs an archived hour; any failure exits 1, so the cron run shows it.
 *
 * Lines are kept as Railway returns them: the logger's JSON fields are in
 * `attributes`, one JSON string, because Axiom's free plan allows 256 fields
 * per dataset and 689 call sites name their own.
 */

const RAILWAY_API = "https://backboard.railway.com/graphql/v2"
const HOUR_MS = 3_600_000
/** Hours looked back on every run: a skipped or failed run is filled by the next. Railway keeps 7 days on Hobby. */
const HEAL_HOURS = 48
/** An hour is read once Railway has had this long to take its last lines. */
const SETTLE_MS = 5 * 60_000
/** Lines per `deploymentLogs` call. A full page halves the window, down to a second. */
const PAGE = 5000
const MIN_WINDOW_MS = 1000
/** Per call, so a hung Railway, Tigris or Axiom ends the run instead of stalling it until the next one is skipped. */
const CALL_TIMEOUT_MS = 30_000
/** Axiom takes at most 10,000 events per request. */
const AXIOM_BATCH = 10_000
/**
 * Deployments asked for an hour: the newest that could have served it.
 * ponytail: five deploys inside one hour, the newest of which never went live,
 * would leave an older live one out; read each deployment's end if that happens.
 */
const CANDIDATES = 5
const NEVER_SERVED = new Set(["FAILED", "SKIPPED", "BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"])

type Deployment = { id: string; status: string; createdAt: string }
type Row = { timestamp: string; message: string; severity: string; attributes: { key: string; value: string }[] }
export type ArchivedLine = { _time: string; env: string; level: string; message: string; deploymentId: string; attributes: string }
export type ArchiveResult = { written: { key: string; lines: number }[]; failures: string[]; axiom?: "not configured" }

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function railwayAuth(): Record<string, string> {
  if (process.env.RAILWAY_LOGS_PROJECT_TOKEN) return { "Project-Access-Token": process.env.RAILWAY_LOGS_PROJECT_TOKEN }
  if (process.env.RAILWAY_LOGS_API_TOKEN) return { authorization: `Bearer ${process.env.RAILWAY_LOGS_API_TOKEN}` }
  throw new Error("RAILWAY_LOGS_PROJECT_TOKEN (or RAILWAY_LOGS_API_TOKEN) is not set")
}

async function railway<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    headers: { "content-type": "application/json", ...railwayAuth() },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null
  if (!res.ok || !body?.data || body.errors) {
    throw new Error(`Railway API ${res.status}: ${body?.errors?.map((e) => e.message).join("; ") ?? "no data"}`)
  }
  return body.data
}

async function deploymentsOf(): Promise<Deployment[]> {
  const data = await railway<{ deployments: { edges: { node: Deployment }[] } }>(
    `query($input: DeploymentListInput!) { deployments(input: $input, first: 50) { edges { node { id status createdAt } } } }`,
    { input: { projectId: required("RAILWAY_PROJECT_ID"), environmentId: required("RAILWAY_ENVIRONMENT_ID"), serviceId: required("LOGS_SERVICE_ID") } }
  )
  return data.deployments.edges.map((e) => e.node).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/** The lines of [from, to). Railway's endDate is inclusive and a full page is the window's newest lines, so a full page is split. */
async function linesOf(deploymentId: string, from: number, to: number): Promise<Row[]> {
  const { deploymentLogs } = await railway<{ deploymentLogs: Row[] }>(
    `query($deploymentId: String!, $startDate: DateTime, $endDate: DateTime, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, startDate: $startDate, endDate: $endDate, limit: $limit) { timestamp message severity attributes { key value } } }`,
    { deploymentId, startDate: new Date(from).toISOString(), endDate: new Date(to).toISOString(), limit: PAGE }
  )
  if (deploymentLogs.length >= PAGE) {
    if (to - from <= MIN_WINDOW_MS) throw new Error(`more than ${PAGE} lines in one second of ${deploymentId}`)
    const mid = from + Math.floor((to - from) / 2)
    return [...(await linesOf(deploymentId, from, mid)), ...(await linesOf(deploymentId, mid, to))]
  }
  return deploymentLogs.filter((r) => Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) < to)
}

function toLine(row: Row, env: string, deploymentId: string): ArchivedLine {
  const attributes = Object.fromEntries(
    row.attributes
      .filter((a) => a.key !== "level" && a.key !== "timestamp")
      .map((a) => {
        try {
          return [a.key, JSON.parse(a.value)]
        } catch {
          return [a.key, a.value]
        }
      })
  )
  return { _time: row.timestamp, env, level: row.severity, message: row.message, deploymentId, attributes: JSON.stringify(attributes) }
}

function keyOf(env: string, hour: number): string {
  const iso = new Date(hour).toISOString()
  return `logs/${env}/${iso.slice(0, 10)}/${iso.slice(11, 13)}.ndjson.gz`
}

async function archivedKeys(env: string, hours: number[]): Promise<Set<string>> {
  const days = [...new Set(hours.map((h) => new Date(h).toISOString().slice(0, 10)))]
  const keys = new Set<string>()
  for (const day of days) {
    let token: string | undefined
    do {
      const page = await getS3Client().send(
        new ListObjectsV2Command({ Bucket: bucketFor("claims"), Prefix: `logs/${env}/${day}/`, ContinuationToken: token }),
        { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) }
      )
      for (const o of page.Contents ?? []) if (o.Key) keys.add(o.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  return keys
}

async function toAxiom(lines: ArchivedLine[]): Promise<void> {
  const domain = process.env.AXIOM_DOMAIN || "us-east-1.aws.edge.axiom.co"
  const url = `https://${domain}/v1/ingest/${encodeURIComponent(required("AXIOM_DATASET"))}`
  for (let i = 0; i < lines.length; i += AXIOM_BATCH) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${required("AXIOM_TOKEN")}`, "content-type": "application/x-ndjson" },
      body: lines.slice(i, i + AXIOM_BATCH).map((l) => JSON.stringify(l)).join("\n"),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => null)) as { failed?: number } | null
    if (!res.ok || (body?.failed ?? 0) > 0) throw new Error(`Axiom ${res.status}${body?.failed ? `, ${body.failed} refused` : ""}`)
  }
}

/** One hour: archived, then sent to Axiom. Throws with the hour named. */
async function archiveHour(env: string, hour: number, deployments: Deployment[], axiom: boolean): Promise<{ key: string; lines: number }> {
  const end = hour + HOUR_MS
  const serving = deployments.filter((d) => Date.parse(d.createdAt) < end && !NEVER_SERVED.has(d.status)).slice(0, CANDIDATES)
  const lines: ArchivedLine[] = []
  for (const d of serving) for (const row of await linesOf(d.id, hour, end)) lines.push(toLine(row, env, d.id))
  lines.sort((a, b) => Date.parse(a._time) - Date.parse(b._time))

  const key = keyOf(env, hour)
  const body = gzipSync(lines.map((l) => JSON.stringify(l) + "\n").join(""))
  await getS3Client().send(
    new PutObjectCommand({ Bucket: bucketFor("claims"), Key: key, Body: body, ContentType: "application/gzip", CacheControl: "private, no-store" }),
    { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) }
  )
  if (axiom && lines.length > 0) {
    try {
      await toAxiom(lines)
    } catch (err) {
      throw new Error(`${new Date(hour).toISOString()} archived, not in Axiom: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { key, lines: lines.length }
}

/** Every whole hour of the last `HEAL_HOURS` not yet archived, or the one hour asked for (`YYYY-MM-DDTHH`). */
export async function archiveLogs(now: Date, onlyHour?: string): Promise<ArchiveResult> {
  const result: ArchiveResult = { written: [], failures: [] }
  try {
    const env = required("RAILWAY_ENVIRONMENT_NAME")
    if (!/^[a-z0-9-]+$/.test(env)) throw new Error(`unexpected environment name ${env}`)
    let hours: number[]
    if (onlyHour) {
      const hour = Date.parse(`${onlyHour.slice(0, 13)}:00:00Z`)
      if (Number.isNaN(hour) || hour + HOUR_MS > now.getTime()) throw new Error(`not a whole past hour: ${onlyHour}`)
      hours = [hour]
    } else {
      const last = Math.floor((now.getTime() - SETTLE_MS) / HOUR_MS) * HOUR_MS - HOUR_MS
      const all = Array.from({ length: HEAL_HOURS }, (_, i) => last - (HEAL_HOURS - 1 - i) * HOUR_MS)
      const done = await archivedKeys(env, all)
      hours = all.filter((h) => !done.has(keyOf(env, h)))
    }
    // Neither set: the archive runs alone (it is the CERT-In record) and says so on every run.
    const axiom = Boolean(process.env.AXIOM_TOKEN || process.env.AXIOM_DATASET)
    if (!axiom) result.axiom = "not configured"
    if (hours.length === 0) return result
    const deployments = await deploymentsOf()
    for (const hour of hours) {
      try {
        result.written.push(await archiveHour(env, hour, deployments, axiom))
      } catch (err) {
        result.failures.push(`${new Date(hour).toISOString()}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    result.failures.push(err instanceof Error ? err.message : String(err))
  }
  return result
}

if (require.main === module) {
  archiveLogs(new Date(), process.argv[2]).then(({ written, failures, axiom }) => {
    if (axiom) console.warn("Axiom not configured (AXIOM_TOKEN, AXIOM_DATASET): archive only")
    for (const w of written) console.log(`archived ${w.key} (${w.lines} lines)`)
    for (const f of failures) console.error(`log archive failed: ${f}`)
    process.exit(failures.length > 0 ? 1 : 0)
  })
}
