import { PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"
import { gzipSync } from "zlib"

import { bucketFor, getS3Client } from "../lib/tigris"

/**
 * The log archive (SCRUM-1497, register D-041). Run hourly as its own Railway
 * cron service per environment (`15 * * * *`), never inside the web service:
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
const SETTLE_MS = 10 * 60_000
/** Lines per `deploymentLogs` call, Railway's maximum (it refuses more). A full page halves the window, down to a second. */
const PAGE = 5000
const MIN_WINDOW_MS = 1000
/** Per call, so a hung Railway, Tigris or Axiom ends the run instead of stalling it until the next one is skipped. */
const CALL_TIMEOUT_MS = 30_000
/** Axiom takes at most 10,000 events per request. */
const AXIOM_BATCH = 10_000
/** Deployments asked for an hour: the newest created before its end, which must reach back to one live at its start. */
const CANDIDATES = 5
/** Deployments listed per run; the newest come first. */
const LISTED = 50
/** `claims` is a private folder, so this is TIGRIS_PRIVATE_BUCKET: never the public one. */
const PRIVATE_BUCKET = bucketFor("claims")

type Deployment = { id: string; status: string; createdAt: string }
type Row = { timestamp: string; message: string; severity: string; attributes: { key: string; value: string }[] }
type ArchivedLine = { _time: string; env: string; level: string; message: string; deploymentId: string; attributes: string }
export type ArchiveResult = { written: { key: string; lines: number }[]; failures: string[]; axiom?: "not configured" }

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function railway<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(RAILWAY_API, {
    method: "POST",
    // A project token: one environment, made by the owner (DEPLOYMENT.md, Logs). Never a broader one.
    headers: { "content-type": "application/json", "Project-Access-Token": required("RAILWAY_LOGS_PROJECT_TOKEN") },
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
    `query($input: DeploymentListInput!, $first: Int) { deployments(input: $input, first: $first) { edges { node { id status createdAt } } } }`,
    { input: { projectId: required("RAILWAY_PROJECT_ID"), environmentId: required("RAILWAY_ENVIRONMENT_ID"), serviceId: required("LOGS_SERVICE_ID") }, first: LISTED }
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
  if (deploymentLogs.some((r) => Number.isNaN(Date.parse(r.timestamp)))) throw new Error(`unreadable timestamp in ${deploymentId}`)
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
        new ListObjectsV2Command({ Bucket: PRIVATE_BUCKET, Prefix: `logs/${env}/${day}/`, ContinuationToken: token }),
        { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) }
      )
      for (const o of page.Contents ?? []) if (o.Key) keys.add(o.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  }
  return keys
}

type AxiomTarget = { url: string; token: string }

/** Neither variable: null, the archive runs alone. One without the other, or a host that is not Axiom's: refused before anything runs. */
function axiomTarget(): AxiomTarget | null {
  if (!process.env.AXIOM_TOKEN && !process.env.AXIOM_DATASET) return null
  const domain = process.env.AXIOM_DOMAIN || "us-east-1.aws.edge.axiom.co"
  if (!/^[a-z0-9.-]+\.axiom\.co$/.test(domain)) throw new Error(`AXIOM_DOMAIN must be an axiom.co host: ${domain}`)
  return { url: `https://${domain}/v1/ingest/${encodeURIComponent(required("AXIOM_DATASET"))}`, token: required("AXIOM_TOKEN") }
}

async function toAxiom(lines: ArchivedLine[], { url, token }: AxiomTarget): Promise<void> {
  for (let i = 0; i < lines.length; i += AXIOM_BATCH) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
      body: lines.slice(i, i + AXIOM_BATCH).map((l) => JSON.stringify(l)).join("\n"),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => null)) as { failed?: number } | null
    if (!res.ok || (body?.failed ?? 0) > 0) throw new Error(`Axiom ${res.status}${body?.failed ? `, ${body.failed} refused` : ""}`)
  }
}

/** One hour: archived, then sent to Axiom. Throws with the hour named. */
async function archiveHour(
  env: string,
  hour: number,
  deployments: Deployment[],
  axiom: AxiomTarget | null,
  again: boolean
): Promise<{ key: string; lines: number }> {
  const end = hour + HOUR_MS
  // Failed ones too: a deploy that never went healthy logged why.
  const serving = deployments.filter((d) => Date.parse(d.createdAt) < end).slice(0, CANDIDATES)
  const reachesStart = serving.some((d) => Date.parse(d.createdAt) <= hour)
  // Without one live at the start, part of the hour would be archived as if it were all of it.
  if (!reachesStart && (serving.length === 0 || serving.length === CANDIDATES || deployments.length === LISTED)) {
    throw new Error(`no deployment of LOGS_SERVICE_ID seen live at the start of the hour (${serving.length} asked of ${deployments.length} listed)`)
  }
  const lines: ArchivedLine[] = []
  for (const d of serving) for (const row of await linesOf(d.id, hour, end)) lines.push(toLine(row, env, d.id))
  lines.sort((a, b) => Date.parse(a._time) - Date.parse(b._time))
  if (again && lines.length === 0) throw new Error("Railway has no lines for this hour (past its log window?); the archive is left as it is")

  const key = keyOf(env, hour)
  const body = gzipSync(lines.map((l) => JSON.stringify(l) + "\n").join(""))
  await getS3Client().send(
    new PutObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key, Body: body, ContentType: "application/gzip", CacheControl: "private, no-store" }),
    { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) }
  )
  if (axiom && lines.length > 0) {
    try {
      await toAxiom(lines, axiom)
    } catch (err) {
      throw new Error(`archived, not in Axiom: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { key, lines: lines.length }
}

/** Every whole hour of the last `HEAL_HOURS` not yet archived, or the one hour asked for (`YYYY-MM-DDTHH`). */
export async function archiveLogs(now: Date, onlyHour?: string): Promise<ArchiveResult> {
  const result: ArchiveResult = { written: [], failures: [] }
  if (!process.env.RAILWAY_LOGS_PROJECT_TOKEN) return { ...result, failures: ["RAILWAY_LOGS_PROJECT_TOKEN is not set: the archive did not run"] }
  try {
    const env = required("RAILWAY_ENVIRONMENT_NAME")
    if (!/^[a-z0-9-]+$/.test(env)) throw new Error(`unexpected environment name ${env}`)
    if (PRIVATE_BUCKET === bucketFor("profile")) throw new Error("the private bucket is the public one: set TIGRIS_PRIVATE_BUCKET")
    const axiom = axiomTarget()
    if (!axiom) result.axiom = "not configured"
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
    if (hours.length === 0) return result
    const deployments = await deploymentsOf()
    for (const hour of hours) {
      try {
        result.written.push(await archiveHour(env, hour, deployments, axiom, Boolean(onlyHour)))
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
  }).catch((err) => {
    console.error("log archive failed:", err)
    process.exit(1)
  })
}
