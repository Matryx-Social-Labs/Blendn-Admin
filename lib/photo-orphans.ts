// Relative imports: reachable from `server.ts` (via `background.ts`), which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { logger } from "./logger"
import { deleteFile, extractKeyFromUrl, listPublicObjects } from "./tigris"

/**
 * Objects under `profile/<uid>/` that no profile points at, out of the public
 * bucket (SCRUM-730).
 *
 * Every other path takes an object out when it knows to: a removed photo (the
 * app's own delete), a replaced or cleared blur (SCRUM-520), a pulled one
 * (SCRUM-479), a deleted account (the prefix purge). What was left is whatever
 * those paths missed: a photo replaced by a write that did not delete it, the
 * raw upload a sealed copy was made from (the original, with its metadata), a
 * blur two concurrent writes replaced, an object from a client bug already
 * fixed. Each stays served at its URL to anyone who ever held it.
 *
 * ## What counts as referenced
 *
 * A key is kept if the person's profile (`photos`, `blur_photo`) or `User.image`
 * names it, however the URL is spelled (virtual-hosted, path-style, a query
 * string). Everything else older than the grace window is an orphan -- except what moderation holds: a
 * pulled photo whose withdrawal to the private bucket failed, and one it has
 * not judged yet, both still the only copy of what the 180-day hold keeps
 * (docs/RETENTION.md). `deleteFile` only reaches the public bucket.
 *
 * ## Why it is careful
 *
 * It deletes public photos, so it is dry-run unless `PHOTO_ORPHAN_SWEEP=delete`;
 * it never takes anything younger than `ORPHAN_GRACE_MS` (an upload in flight,
 * a seal not yet attached, a photo put back from another device); it deletes at most `MAX_DELETES_PER_PASS`; and it
 * refuses a pass in which almost everything looks orphaned, which is what a
 * broken reference read looks like, not what a bucket looks like.
 */
export const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000
/** An upload is presigned for 15 minutes and sealed on attach; three days also covers a photo taken off one device and put back from another. */
export const ORPHAN_GRACE_MS = 3 * 24 * 60 * 60 * 1000
export const MAX_DELETES_PER_PASS = 200
/** Pages of 1,000 keys read per pass; the cursor carries on at the next. */
const MAX_PAGES_PER_PASS = 5
/** Above this share of a big-enough batch looking orphaned, the pass is refused. */
export const MAX_ORPHAN_SHARE = 0.8
export const SANITY_FLOOR = 50

export type OrphanMode = "off" | "log" | "delete"

/** `PHOTO_ORPHAN_SWEEP`: unset is a dry run that logs; `delete` deletes; `off` does nothing. */
export function orphanModeFromEnv(raw: string | undefined = process.env.PHOTO_ORPHAN_SWEEP): OrphanMode {
  const v = raw?.trim().toLowerCase()
  return v === "delete" ? "delete" : v === "off" ? "off" : "log"
}

export interface OrphanPass {
  mode: OrphanMode
  /** Objects read this pass. */
  listed: number
  /** Old enough to judge. */
  judged: number
  orphans: number
  deleted: number
  refused: boolean
  /** The whole bucket has been read; the next pass starts again. */
  complete: boolean
}

/**
 * Every key a stored reference could mean: the host-aware reading, the URL's
 * path, the path without its first segment (a path-style URL of an old bucket
 * name), and the value itself when it is already a bare key. Over-protective on
 * purpose: a key wrongly kept costs a stale object, a key wrongly taken costs a
 * photo someone is looking at.
 */
function keysOfReference(ref: string): string[] {
  const out = new Set<string>()
  const add = (k: string | null) => k && out.add(decodeKey(k.replace(/^\//, "")))
  add(extractKeyFromUrl(ref))
  try {
    const path = new URL(ref).pathname.replace(/^\//, "")
    add(path)
    add(path.split("/").slice(1).join("/"))
  } catch {
    add(ref.split(/[?#]/)[0])
  }
  return [...out]
}
const decodeKey = (k: string) => {
  try {
    return decodeURIComponent(k)
  } catch {
    return k
  }
}

/** `profile/<uid>/<name>` -> uid, or null for any other shape. */
const ownerOf = (key: string): string | null => {
  const m = /^profile\/([^/]+)\/[^/].*$/.exec(key)
  return m ? m[1] : null
}

let cursor: string | undefined

export async function sweepOrphanPhotos(opts: { now?: Date; mode?: OrphanMode } = {}): Promise<OrphanPass> {
  const now = opts.now ?? new Date()
  const mode = opts.mode ?? orphanModeFromEnv()
  const pass: OrphanPass = { mode, listed: 0, judged: 0, orphans: 0, deleted: 0, refused: false, complete: false }
  if (mode === "off") return pass

  const old: { key: string; uid: string }[] = []
  for (let i = 0; i < MAX_PAGES_PER_PASS; i++) {
    const page = await listPublicObjects("profile/", cursor)
    cursor = page.next
    pass.listed += page.objects.length
    for (const o of page.objects) {
      const uid = ownerOf(o.key)
      if (uid && now.getTime() - o.lastModified.getTime() >= ORPHAN_GRACE_MS) old.push({ key: o.key, uid })
    }
    if (!cursor) {
      pass.complete = true
      break
    }
  }
  pass.judged = old.length
  if (old.length === 0) return pass

  const uids = [...new Set(old.map((o) => o.uid))]
  const [profiles, users, held] = await Promise.all([
    db.profiles.findMany({ where: { id: { in: uids } }, select: { id: true, photos: true, blur_photo: true } }),
    db.user.findMany({ where: { id: { in: uids } }, select: { id: true, image: true } }),
    db.photo_checks.findMany({ where: { user_id: { in: uids }, OR: [{ hidden: true }, { checked: false }] }, select: { url: true } }),
  ])
  // Global, not per owner: a profile that points into another folder protects that object too.
  const referenced = new Set<string>()
  const note = (ref: string | null | undefined) => ref && keysOfReference(ref).forEach((k) => referenced.add(k))
  for (const p of profiles) {
    p.photos.forEach(note)
    note(p.blur_photo)
  }
  for (const u of users) note(u.image)
  // What moderation holds: pulled (its copy to the private bucket may have failed) or not yet judged.
  for (const h of held) note(h.url)

  const orphans = old.filter((o) => !referenced.has(o.key))
  pass.orphans = orphans.length
  if (old.length >= SANITY_FLOOR && orphans.length / old.length > MAX_ORPHAN_SHARE) {
    pass.refused = true
    logger.error("Orphan photo sweep refused: nearly everything looks unreferenced, the reference read is suspect", {
      judged: old.length,
      orphans: orphans.length,
    })
    return pass
  }

  if (mode === "delete") {
    for (const { key, uid } of orphans.slice(0, MAX_DELETES_PER_PASS)) {
      try {
        await deleteFile(key)
        pass.deleted++
      } catch (error) {
        logger.error("Orphan photo not deleted", { userId: uid, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  logger.info(mode === "delete" ? "Orphan photo sweep" : "Orphan photo sweep (dry run: PHOTO_ORPHAN_SWEEP=delete deletes)", {
    listed: pass.listed,
    judged: pass.judged,
    orphans: pass.orphans,
    deleted: pass.deleted,
    complete: pass.complete,
  })
  return pass
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function run(): Promise<void> {
  try {
    await sweepOrphanPhotos()
  } catch (error) {
    logger.error("Orphan photo sweep failed", { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Self-scheduling, like the other sweepers. */
export function startOrphanPhotoSweeper(): void {
  if (timer) return
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => void run().finally(schedule), ORPHAN_SWEEP_INTERVAL_MS)
    timer.unref?.()
  }
  void run().finally(schedule)
}

/** Stops the loop, and the next start reads the bucket from the top again. */
export function stopOrphanPhotoSweeper(): void {
  cursor = undefined
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
