/**
 * Downloads a clip from a link somebody pasted: untrusted, so https only, public
 * addresses only, and capped in redirects, size and time.
 *
 * The address is checked inside `lookup`, at connect: the IP checked is the IP
 * connected to, so a name that resolves differently a second time (DNS
 * rebinding) gains nothing. A literal IP never reaches `lookup`, so it is
 * checked before. Redirects are followed by hand and each hop goes through both.
 */
import { createWriteStream } from "node:fs"
import { lookup as dnsLookup } from "node:dns"
import { request as httpsRequest } from "node:https"
import type { IncomingMessage } from "node:http"
import { BlockList, isIP } from "node:net"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

export const MAX_BYTES = 50 * 1024 * 1024
const MAX_REDIRECTS = 3
const DOWNLOAD_MS = 45_000

export class FetchRefusal extends Error {
  readonly reason: "unreachable" | "too_big"
  readonly bytes: number | undefined
  constructor(reason: "unreachable" | "too_big", bytes?: number) {
    super(reason)
    this.reason = reason
    this.bytes = bytes
  }
}

const refusedV4 = new BlockList()
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) refusedV4.addSubnet(net, bits, "ipv4")

/** Only global unicast is public; inside it, the ranges that carry or stand for something else. */
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
const refusedV6 = new BlockList()
for (const [net, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) refusedV6.addSubnet(net, bits, "ipv6")

/** Whether an address is on the public internet. Anything unrecognised is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !refusedV4.check(address, "ipv4")
  if (family === 6) return globalV6.check(address, "ipv6") && !refusedV6.check(address, "ipv6")
  return false
}

/** The link as a URL we are willing to open, or null. */
export function openableUrl(link: string, base?: string): URL | null {
  let url: URL
  try {
    url = new URL(link, base)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(host) && !isPublicAddress(host)) return null
  return url
}

type Resolved = { address: string; family: number }
type Resolve = (host: string, done: (error: Error | null, found: Resolved[]) => void) => void

const resolveAll: Resolve = (host, done) => dnsLookup(host, { all: true }, (error, found) => done(error, found ?? []))

/** A `lookup` for https.request that refuses a name with any private address. Exported with its resolver for the test. */
export function publicLookup(resolve: Resolve = resolveAll) {
  return (
    host: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: string | Resolved[], family?: number) => void
  ): void =>
    resolve(host, (error, found) => {
      if (error) return callback(error, "")
      if (found.length === 0 || !found.every((a) => isPublicAddress(a.address))) return callback(new FetchRefusal("unreachable"), "")
      if (options.all) return callback(null, found)
      callback(null, found[0].address, found[0].family)
    })
}

function connect(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { lookup: publicLookup() as never, signal, agent: false, headers: { "user-agent": "media-check/1.0", accept: "video/mp4,video/*;q=0.9", "accept-encoding": "identity" } },
      resolve
    )
    request.on("error", reject)
    request.end()
  })
}

/** Follows redirects by hand: every hop is a new link, checked like the first. */
async function openFollowing(link: string, signal: AbortSignal): Promise<IncomingMessage> {
  let url = openableUrl(link)
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    const response = await connect(url, signal)
    const status = response.statusCode ?? 0
    if (status === 200) return response
    response.destroy()
    if (![301, 302, 303, 307, 308].includes(status) || !response.headers.location) break
    url = openableUrl(response.headers.location, url.href)
  }
  throw new FetchRefusal("unreachable")
}

/** Counts what passes and stops at the cap: a `content-length` is a claim, not a limit. */
export function capBytes(max: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length
      if (seen > max) return done(new FetchRefusal("too_big"))
      done(null, chunk)
    },
  })
}

/** Downloads `link` to `path`, or throws a FetchRefusal. */
export async function fetchClip(link: string, path: string, job: AbortSignal): Promise<void> {
  const signal = AbortSignal.any([job, AbortSignal.timeout(DOWNLOAD_MS)])
  try {
    const response = await openFollowing(link, signal)
    const declared = Number(response.headers["content-length"])
    if (declared > MAX_BYTES) {
      response.destroy()
      throw new FetchRefusal("too_big", declared)
    }
    await pipeline(response, capBytes(MAX_BYTES), createWriteStream(path), { signal })
  } catch (error) {
    if (error instanceof FetchRefusal) throw error
    // The job ran out, or nobody is waiting: that says nothing about the link.
    job.throwIfAborted()
    throw new FetchRefusal("unreachable")
  }
}
