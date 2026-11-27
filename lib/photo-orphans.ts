// Relative imports: reachable from `server.ts` (via `background.ts`), which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { logger } from "./logger"
import { bucketFor, deleteFile, extractKeyFromUrl, listPublicObjects } from "./tigris"

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
 *
 * ## Raw chat uploads (SCRUM-1387)
 *
 * The same pass, the same switch, grace and budget, over `chat/<uid>/` in the
 * private bucket (`bucketFor("chat")`): an upload that was never sent. What a message keeps is its
 * sealed copy, so these are judged against every stored string that can still
 * name a raw key (`chatReferences`). The share refusal does not fit there (an
 * old raw upload is unsent by construction); instead a key is only taken when
 * its owner is a user of this database, and a reference it cannot read refuses
 * the pass.
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
  /** Deletes that failed; each is logged with its key. */
  failed: number
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

interface Judged {
  key: string
  uid: string
}

/** One prefix in one bucket: what it may judge, and what of that no reference keeps. */
interface Target {
  /** Names the sweep in its log lines: "photo", "chat upload". */
  label: string
  bucket: string
  prefix: string
  /** The owner of a key this sweep may judge, or null to leave it alone. */
  ownerOf: (key: string) => string | null
  orphansOf: (old: Judged[]) => Promise<{ orphans: Judged[]; refused: boolean }>
}

const cursors = new Map<string, string | undefined>()

async function sweepTarget(target: Target, now: Date, mode: OrphanMode, maxDeletes: number): Promise<OrphanPass> {
  const pass: OrphanPass = { mode, listed: 0, judged: 0, orphans: 0, deleted: 0, failed: 0, refused: false, complete: false }
  if (mode === "off") return pass

  const old: Judged[] = []
  for (let i = 0; i < MAX_PAGES_PER_PASS; i++) {
    const page = await listPublicObjects(target.prefix, cursors.get(target.label), target.bucket)
    cursors.set(target.label, page.next)
    pass.listed += page.objects.length
    for (const o of page.objects) {
      const uid = target.ownerOf(o.key)
      if (uid && now.getTime() - o.lastModified.getTime() >= ORPHAN_GRACE_MS) old.push({ key: o.key, uid })
    }
    if (!page.next) {
      pass.complete = true
      break
    }
  }
  pass.judged = old.length
  if (old.length === 0) return pass

  const { orphans, refused } = await target.orphansOf(old)
  pass.orphans = orphans.length
  if (refused) {
    pass.refused = true
    return pass
  }

  if (mode === "delete") {
    for (const { key, uid } of orphans.slice(0, Math.max(0, maxDeletes))) {
      try {
        // Only where it was listed and judged: `deleteFile` alone would also reach a bucket this pass never read.
        await deleteFile(key, target.bucket)
        pass.deleted++
      } catch (error) {
        pass.failed++
        logger.error(`Orphan ${target.label} not deleted`, {
          userId: uid,
          key,
          bucket: target.bucket,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  logger.info(mode === "delete" ? `Orphan ${target.label} sweep` : `Orphan ${target.label} sweep (dry run: PHOTO_ORPHAN_SWEEP=delete deletes)`, {
    listed: pass.listed,
    judged: pass.judged,
    orphans: pass.orphans,
    deleted: pass.deleted,
    failed: pass.failed,
    complete: pass.complete,
  })
  return pass
}

const profileTarget: Target = {
  label: "photo",
  bucket: bucketFor("profile"),
  prefix: "profile/",
  ownerOf,
  async orphansOf(old) {
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
    const refused = old.length >= SANITY_FLOOR && orphans.length / old.length > MAX_ORPHAN_SHARE
    if (refused) {
      logger.error("Orphan photo sweep refused: nearly everything looks unreferenced, the reference read is suspect", {
        judged: old.length,
        orphans: orphans.length,
      })
    }
    return { orphans, refused }
  },
}

/**
 * `chat/<uid>/<name>` -> uid, for a raw upload only. Not `chat/sealed/` (what
 * messages store; an unsent one is `discardSealedChatMedia`'s), not a `-sealed`
 * copy from before SCRUM-448, and nothing outside the alphabet `generateKey`
 * writes: a key it cannot match exactly against a reference is left alone.
 */
const chatOwnerOf = (key: string): string | null => {
  const m = /^chat\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/.exec(key)
  return m && m[1].toLowerCase() !== "sealed" && !m[2].endsWith("-sealed") ? m[1] : null
}

/**
 * The keys a stored string names, or null when it names `chat/` in a form this
 * cannot read. The separators are undone (`\/`, `%2F`, `%252F`); nothing else
 * needs decoding, because the alphabet `chatOwnerOf` judges is never
 * percent-encoded. Every `chat/` then runs to the first character outside that
 * alphabet and `/`. A `%` or `\` there is an encoding left over, so the string
 * is unreadable (unless it escapes a quote or a control character); any other
 * character ends it. `chat/<seg>/<name>` names a key
 * (and, ending a sentence, the same without its trailing dots); a bare
 * `chat/<id>`, such as a deep link, names none.
 */
function chatKeysIn(ref: string): string[] | null {
  const text = ref.replace(/\\+\//g, "/").replace(/%(?:25)*2f/gi, "/")
  const keys: string[] = []
  // Zero-width, so a `chat/` inside or right after another is read on its own.
  for (const m of text.matchAll(/(?=chat\/([A-Za-z0-9._/-]*)(.?)(.?))/g)) {
    // An escaped quote or control character (JSON inside a string) ends a key; any other escape may hide one.
    if (m[2] === "%" || (m[2] === "\\" && !/["nrt]/.test(m[3]))) return null
    const [seg, name] = m[1].split("/")
    if (seg && name) keys.push(`chat/${seg}/${name}`, `chat/${seg}/${name.replace(/\.+$/, "")}`)
  }
  return keys
}

/** The one audit action that stores an object key (`lib/moderation/sexual-image-hold.ts`; `git grep "details: {"`). A new one that does goes here. */
const AUDIT_ACTIONS_WITH_KEYS = ["moderation.sexual_image_hold"]

/** `chat`, a separator (`/`, `\/`, `%2F` at any depth), and not a sealed copy's `sealed/`. */
const NAMES_RAW_CHAT = "chat(\\\\*/|%(25)*2f)(?!sealed(/|\\\\|%))"

/**
 * Every stored string that can name a raw chat upload (SCRUM-1387). Since
 * sealing (SCRUM-425) every writer stores `chat/sealed/<uuid>` and deletes the
 * upload, so only older rows name one, and before SCRUM-426 a message could
 * carry anybody's URL: read globally, not per sender. JSON is read as text, so
 * a key under any field counts. Moderation flags and reports point at these
 * messages by id. Text a person typed is not read: a pasted link is not an
 * attachment, and keeping an object for one is the free hosting this sweep ends.
 *
 * ponytail: full scans, once a pass and only when an old upload is waiting,
 * under the server's statement timeout. A cancelled read deletes nothing and is
 * logged as a failed sweep; a `SET LOCAL statement_timeout` or a partial index on
 * the legacy rows when that is seen.
 */
const chatReferences = () => db.$queryRaw<{ src: string; id: string; ref: string }[]>`
  SELECT 'private_messages' AS src, id::text AS id, media_url AS ref FROM private_messages WHERE media_url ~* ${NAMES_RAW_CHAT}
  UNION ALL
  SELECT 'chat_messages', id::text, metadata::text FROM chat_messages WHERE metadata::text ~* ${NAMES_RAW_CHAT}
  UNION ALL
  SELECT 'board_posts', id::text, photo_url FROM board_posts WHERE photo_url ~* ${NAMES_RAW_CHAT}
  UNION ALL
  SELECT 'retained_report_media', id::text, object_key FROM retained_report_media WHERE object_key ~* ${NAMES_RAW_CHAT}
  UNION ALL
  SELECT 'audit_logs', id::text, details::text FROM audit_logs
   WHERE action = ANY(${AUDIT_ACTIONS_WITH_KEYS}) AND details::text ~* ${NAMES_RAW_CHAT}
`

const chatTarget: Target = {
  label: "chat upload",
  bucket: bucketFor("chat"),
  prefix: "chat/",
  ownerOf: chatOwnerOf,
  async orphansOf(old) {
    const uids = [...new Set(old.map((o) => o.uid))]
    const [users, refs] = await Promise.all([db.user.findMany({ where: { id: { in: uids } }, select: { id: true } }), chatReferences()])

    const referenced = new Set<string>()
    const unreadable: string[] = []
    for (const { src, id, ref } of refs) {
      const keys = chatKeysIn(ref)
      if (keys) keys.forEach((k) => referenced.add(k))
      else unreadable.push(`${src} ${id}`)
    }
    /*
     * A row that names chat/ in a form this cannot read is a reference it
     * would miss. The share test the profile sweep uses cannot stand in: an
     * old raw upload is unsent by construction, so nearly all of them are.
     */
    if (unreadable.length > 0) {
      logger.error("Orphan chat upload sweep refused: a stored reference to chat/ could not be read", {
        unreadable: unreadable.length,
        rows: unreadable.slice(0, 5),
      })
      return { orphans: [], refused: true }
    }

    // Only a user of this database owns a key it may delete: the bucket is proven to be this database's, key by key.
    const known = new Set(users.map((u) => u.id))
    const unknown = old.filter((o) => !known.has(o.uid)).length
    if (unknown * 2 > old.length) {
      logger.error("Orphan chat uploads kept: their owner is not a user of this database (another environment's bucket?)", {
        judged: old.length,
        unknown,
      })
    }
    return { orphans: old.filter((o) => known.has(o.uid) && !referenced.has(o.key)), refused: false }
  },
}

export async function sweepOrphanPhotos(opts: { now?: Date; mode?: OrphanMode } = {}): Promise<OrphanPass> {
  return sweepTarget(profileTarget, opts.now ?? new Date(), opts.mode ?? orphanModeFromEnv(), MAX_DELETES_PER_PASS)
}

/** Raw chat uploads that were never sent, out of the private bucket (SCRUM-1387). Same switch, grace and budget as photos. */
export async function sweepOrphanChatUploads(opts: { now?: Date; mode?: OrphanMode; maxDeletes?: number } = {}): Promise<OrphanPass> {
  return sweepTarget(chatTarget, opts.now ?? new Date(), opts.mode ?? orphanModeFromEnv(), opts.maxDeletes ?? MAX_DELETES_PER_PASS)
}

/** One pass of both, with one `MAX_DELETES_PER_PASS` between them: photos first, chat takes what is left. A failure in one is logged and the other still runs. */
export async function sweepAllOrphans(opts: { now?: Date; mode?: OrphanMode } = {}): Promise<{ profile: OrphanPass | null; chat: OrphanPass | null }> {
  const guarded = (label: string, sweep: () => Promise<OrphanPass>) =>
    sweep().catch((error: unknown) => {
      logger.error(`Orphan ${label} sweep failed`, { error: error instanceof Error ? error.message : String(error) })
      return null
    })
  const profile = await guarded("photo", () => sweepOrphanPhotos(opts))
  const chat = await guarded("chat upload", () => sweepOrphanChatUploads({ ...opts, maxDeletes: MAX_DELETES_PER_PASS - (profile?.deleted ?? 0) }))
  return { profile, chat }
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

/** Self-scheduling, like the other sweepers. */
export function startOrphanPhotoSweeper(): void {
  if (timer) return
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => void sweepAllOrphans().finally(schedule), ORPHAN_SWEEP_INTERVAL_MS)
    timer.unref?.()
  }
  void sweepAllOrphans().finally(schedule)
}

/** Stops the loop, and the next start reads the bucket from the top again. */
export function stopOrphanPhotoSweeper(): void {
  cursors.clear()
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
