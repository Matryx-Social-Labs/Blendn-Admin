import { randomUUID } from "crypto"

/*
 * Relative imports, not `@/` — this module is in `server.ts`'s graph, which is
 * compiled by `tsc` rather than bundled by Next and cannot resolve the alias.
 * `__tests__/server-import-boundary.test.ts` fails the build on one.
 */

import { chatWindowState } from "./chat-window"
import { SPONSORSHIP } from "./constants"
import { db } from "./db"
import { logger } from "./logger"
import { placementIsRunnable } from "./placement-phase"
import { attendeeLabel } from "./pseudonym"
import { sweepExpiredGrants } from "./upload-grants"

/**
 * When a sponsored campaign actually sends.
 *
 * ## What this replaces, and why
 *
 * `setInterval` in a `Map` on one process. Four things were wrong with it and
 * they compound:
 *
 *   1. **The schedule died on every deploy.** `start()` has no leading edge and
 *      `loadAll()` re-armed from zero on boot, so a 30-minute campaign that was
 *      deployed over twice in an evening sent nothing at all. `last_sent_at` was
 *      written and never read, so there was no way to notice.
 *   2. **Two processes meant two copies of every ad.** Nothing coordinated, so
 *      scaling past one container doubled the send rate. The room cap said 20
 *      minutes and the room got one every 10.
 *   3. **A crash mid-send left no record.** No row said "this window ran", so a
 *      restart re-sent or skipped depending on timing, unpredictably.
 *   4. **The content was captured in the closure.** An edit re-armed with the new
 *      text; a *rejection* did not, so a rejected creative kept firing.
 *
 * The fix is the standard one and it is boring on purpose: the schedule lives in
 * the database, one worker claims a row at a time, and a row records the window
 * before anything is sent.
 *
 * ## The pass
 *
 *   claim    `FOR UPDATE SKIP LOCKED` over rows whose `next_send_at` is due,
 *            stamping `claim_token`. Two processes running this simultaneously
 *            get disjoint sets rather than the same one.
 *   outbox   insert `sponsored_message_sends (campaign, scheduled_for)` with
 *            `ON CONFLICT DO NOTHING`. Zero rows inserted means this window has
 *            already run somewhere — the retry is a no-op instead of a repeat.
 *   send     post the message, then link it to the outbox row.
 *   finalize clear the claim, move `next_send_at`, reset the failure count.
 *
 * A crash between *outbox* and *send* loses one send. That direction is chosen
 * deliberately: in a pseudonymous room where every other participant is a
 * nickname, the same ad twice is more damaging than one that did not arrive, and
 * the next window is at least twenty minutes away.
 *
 * ## What is re-checked every pass, and what is not
 *
 * Re-checked: the placement is still `approved`, the creative is still
 * `approved`, the chat window is still open, and the room has not carried
 * another sponsor's message within `ROOM_MIN_GAP_MINUTES`. All four can change
 * after a campaign is switched on, and the old scheduler asked none of them
 * after arming.
 *
 * Deliberately NOT re-checked: `organisations.may_sponsor`.
 * `lib/onboarding-actions.ts` states the rule — revoking the grant stops new
 * campaigns being created, and does not silently kill placements an organiser
 * has already paid for. Cancelling the placement is the switch that stops sends,
 * and that one *is* re-checked here.
 */

/** How long a claim is honoured before another worker may take the row. */
const LEASE_MINUTES = 5

/** Rows per pass. Bounded so one slow pass cannot hold a claim on everything. */
const BATCH = 25

const SWEEP_INTERVAL_MS = 60_000

interface ClaimedCampaign {
  id: string
  event_id: string
  content: string
  interval_minutes: number
  sponsor_id: string
  scheduled_for: Date
  consecutive_failures: number
}

/**
 * Claim due campaigns.
 *
 * Raw because Prisma cannot express `FOR UPDATE SKIP LOCKED`, and without it two
 * workers select the same rows and both send. The `UPDATE ... FROM` shape holds
 * the CTE's row locks for the whole statement, so the claim is atomic with the
 * selection.
 */
async function claimDue(now: Date, token: string): Promise<ClaimedCampaign[]> {
  const leaseCutoff = new Date(now.getTime() - LEASE_MINUTES * 60_000)

  return db.$queryRaw<ClaimedCampaign[]>`
    WITH due AS (
      SELECT m.id
        FROM "event_sponsored_messages" m
        JOIN "events" e ON e."id" = m."event_id"
        JOIN "event_sponsors" p
          ON p."event_id" = m."event_id" AND p."sponsor_id" = m."sponsor_id"
       WHERE m."is_active"
         AND m."sponsor_id" IS NOT NULL
         AND m."next_send_at" IS NOT NULL
         AND m."next_send_at" <= ${now}
         AND m."moderation_status" = 'approved'::"moderation_status_type"
         AND (m."claim_token" IS NULL OR m."claimed_at" IS NULL OR m."claimed_at" < ${leaseCutoff})
         AND p."status" = 'approved'::"placement_status"
         AND e."deleted_at" IS NULL
       ORDER BY m."next_send_at" ASC
       LIMIT ${BATCH}
       FOR UPDATE OF m SKIP LOCKED
    )
    UPDATE "event_sponsored_messages" m
       SET "claim_token" = ${token}::uuid, "claimed_at" = ${now}
      FROM due
     WHERE m."id" = due."id"
    RETURNING m."id", m."event_id", m."content", m."interval_minutes",
              m."sponsor_id", m."next_send_at" AS "scheduled_for",
              m."consecutive_failures"
  `
}

/** Release the claim and set the next window. Guarded on still holding it. */
async function finalize(
  campaign: ClaimedCampaign,
  token: string,
  now: Date,
  opts: { sent: boolean } = { sent: true }
): Promise<void> {
  /*
   * From `now`, not from `scheduled_for`.
   *
   * A worker that has been down for three hours would otherwise walk the
   * schedule forward one interval at a time, firing the whole backlog into the
   * room as fast as it can claim rows. Nobody wants yesterday's ads.
   */
  const next = new Date(now.getTime() + campaign.interval_minutes * 60_000)

  await db.event_sponsored_messages.updateMany({
    where: { id: campaign.id, claim_token: token },
    data: {
      claim_token: null,
      claimed_at: null,
      next_send_at: next,
      consecutive_failures: 0,
      ...(opts.sent ? { last_sent_at: now } : {}),
    },
  })
}

/** Stop a campaign for good, with the reason on the row. */
async function deactivate(campaignId: string, token: string, reason: string): Promise<void> {
  await db.event_sponsored_messages.updateMany({
    where: { id: campaignId, claim_token: token },
    data: {
      is_active: false,
      claim_token: null,
      claimed_at: null,
      next_send_at: null,
      deactivated_reason: reason,
    },
  })
  logger.info("Sponsored campaign deactivated", { campaignId, reason })
}

/** Push the window out without counting a send — used by the room-gap defer. */
async function defer(campaignId: string, token: string, until: Date): Promise<void> {
  await db.event_sponsored_messages.updateMany({
    where: { id: campaignId, claim_token: token },
    data: { claim_token: null, claimed_at: null, next_send_at: until },
  })
}

async function recordFailure(
  campaign: ClaimedCampaign,
  token: string,
  now: Date,
  error: unknown
): Promise<void> {
  const failures = campaign.consecutive_failures + 1
  logger.error("Sponsored send failed", {
    campaignId: campaign.id,
    failures,
    error: error instanceof Error ? error.message : String(error),
  })

  if (failures >= SPONSORSHIP.FAILURE_LIMIT) {
    await db.event_sponsored_messages.updateMany({
      where: { id: campaign.id, claim_token: token },
      data: {
        is_active: false,
        claim_token: null,
        claimed_at: null,
        next_send_at: null,
        consecutive_failures: failures,
        deactivated_reason: `Stopped after ${failures} consecutive send failures.`,
      },
    })
    return
  }

  await db.event_sponsored_messages.updateMany({
    where: { id: campaign.id, claim_token: token },
    data: {
      claim_token: null,
      claimed_at: null,
      consecutive_failures: failures,
      next_send_at: new Date(now.getTime() + campaign.interval_minutes * 60_000),
    },
  })
}

export interface SponsoredSweepResult {
  claimed: number
  sent: number
  /** The window had already run — a retry after a crash, not an error. */
  duplicate: number
  deferred: number
  deactivated: number
  failed: number
}

/**
 * One pass. Exported so a test can drive it without a timer.
 */
export async function sweepSponsored(now: Date = new Date()): Promise<SponsoredSweepResult> {
  const token = randomUUID()
  const result: SponsoredSweepResult = {
    claimed: 0,
    sent: 0,
    duplicate: 0,
    deferred: 0,
    deactivated: 0,
    failed: 0,
  }

  /*
   * Reclaim upload grants nobody redeemed, in the same pass.
   *
   * One indexed delete against the `expires_at` index the schema calls "the
   * sweeper's predicate" — not worth its own timer, and a fifth interval in the
   * shutdown handler is a fifth thing to forget to stop. Consumed grants are
   * kept: they are the record of where a live creative's bytes came from.
   */
  try {
    const reclaimed = await sweepExpiredGrants(now)
    if (reclaimed > 0) logger.info("Reclaimed upload grants", { count: reclaimed })
  } catch (error) {
    // Housekeeping must never stop the sends.
    logger.warn("Could not reclaim upload grants", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const claimed = await claimDue(now, token)
  result.claimed = claimed.length
  if (claimed.length === 0) return result

  for (const campaign of claimed) {
    try {
      const outcome = await sendOne(campaign, token, now)
      result[outcome]++
    } catch (error) {
      await recordFailure(campaign, token, now, error)
      result.failed++
    }
  }

  logger.info("Sponsored sweep", { ...result })
  return result
}

type Outcome = "sent" | "duplicate" | "deferred" | "deactivated"

async function sendOne(
  campaign: ClaimedCampaign,
  token: string,
  now: Date
): Promise<Outcome> {
  const event = await db.events.findUnique({
    where: { id: campaign.event_id },
    select: {
      start_time: true,
      end_time: true,
      organizer_id: true,
      chat_group: { select: { id: true, status: true } },
    },
  })

  if (!event?.chat_group) {
    await deactivate(campaign.id, token, "The event has no chatroom.")
    return "deactivated"
  }

  /*
   * Is the commercial agreement still current — a different question from
   * whether the room is open, and the reason both are asked.
   *
   * The room stays open for `CHAT_WINDOW_HOURS` after the event ends so people
   * can give feedback on the way home. `chatWindowState` alone would therefore
   * keep a campaign sending for a full day after the placement finished, into a
   * room whose purpose has changed. The SQL cannot ask this — it is derived from
   * the event's clock, not stored — so it is asked here.
   */
  if (!placementIsRunnable({ status: "approved" }, event, now)) {
    await deactivate(campaign.id, token, "The event has ended.")
    return "deactivated"
  }

  /*
   * The one definition of whether the room is open, including the pre-event
   * floor. A closed room never reopens, so this ends the campaign rather than
   * deferring — which is also what stops the old bug where an archived room
   * received a sponsored message every interval, forever, re-armed by each
   * deploy.
   */
  const window = chatWindowState(event, event.chat_group, now)
  if (!window.open) {
    await deactivate(campaign.id, token, `The chatroom is ${window.reason}.`)
    return "deactivated"
  }

  const groupId = event.chat_group.id

  /*
   * The room-wide gap, across ALL sponsors.
   *
   * `SPONSORSHIP.ROOM_MIN_GAP_MINUTES` is deliberately not a per-campaign rule:
   * three advertisers each behaving perfectly at 30 minutes still put something
   * in the room every ten, and the attendee does not care that each one behaved.
   * Whoever is due first wins the slot; the others are pushed out, not dropped.
   */
  const gapCutoff = new Date(now.getTime() - SPONSORSHIP.ROOM_MIN_GAP_MINUTES * 60_000)
  const recent = await db.sponsored_message_sends.findFirst({
    where: {
      sent_at: { gte: gapCutoff },
      message: { event_id: campaign.event_id },
      NOT: { sponsored_message_id: campaign.id },
    },
    select: { sent_at: true },
    orderBy: { sent_at: "desc" },
  })
  if (recent) {
    const until = new Date(
      recent.sent_at.getTime() + SPONSORSHIP.ROOM_MIN_GAP_MINUTES * 60_000
    )
    await defer(campaign.id, token, until)
    return "deferred"
  }

  /*
   * Which revision runs. The latest approved one, not the campaign's `content`:
   * editing the copy must not rewrite what a past send delivered, which is why
   * `sponsored_message_sends.creative_id` is `onDelete: Restrict`.
   */
  const creative = await db.sponsored_creatives.findFirst({
    where: { message_id: campaign.id, moderation_status: "approved" },
    select: { id: true, content: true, media_url: true, media_type: true },
    orderBy: { created_at: "desc" },
  })
  if (!creative) {
    await deactivate(campaign.id, token, "No approved creative to send.")
    return "deactivated"
  }

  const audience = await roomSnapshot(groupId, campaign.id)

  /*
   * The outbox row, BEFORE the message exists.
   *
   * `@@unique([sponsored_message_id, scheduled_for])` plus `skipDuplicates` is
   * what makes a retry idempotent: a second worker, or this one after a crash,
   * inserts nothing and sends nothing.
   */
  const inserted = await db.sponsored_message_sends.createMany({
    data: [
      {
        sponsored_message_id: campaign.id,
        creative_id: creative.id,
        scheduled_for: campaign.scheduled_for,
        members: audience.members,
        live_connected: audience.connected,
        recipient_hashes: audience.hashes,
      },
    ],
    skipDuplicates: true,
  })

  if (inserted.count === 0) {
    // This window already ran. Move the schedule on rather than sending again.
    await finalize(campaign, token, now, { sent: false })
    return "duplicate"
  }

  /*
   * `image` and `video` are separate message types, not text with a url in the
   * metadata. A client renders a video as a poster with a tap-to-play control
   * and an image inline; a text message with a link is a third thing that
   * autoplays nothing and looks like spam.
   *
   * The URL is the one recorded on the creative, which is pinned to the object
   * VERSION that was reviewed. Overwriting the key after approval therefore
   * changes nothing about what goes out.
   */
  const type = creative.media_url
    ? creative.media_type?.startsWith("video/")
      ? ("video" as const)
      : ("image" as const)
    : ("text" as const)

  const created = await db.chat_messages.create({
    data: {
      chat_group_id: groupId,
      user_id: event.organizer_id,
      type,
      content: `📣 [Sponsored]\n${creative.content}`,
      metadata: {
        sponsored_message_id: campaign.id,
        creative_id: creative.id,
        sponsor_id: campaign.sponsor_id,
        ...(creative.media_url
          ? { media_url: creative.media_url, media_type: creative.media_type }
          : {}),
      },
    },
  })

  await Promise.all([
    db.chat_groups.update({
      where: { id: groupId },
      data: { last_message_at: created.created_at },
    }),
    db.sponsored_message_sends.update({
      where: {
        sponsored_message_id_scheduled_for: {
          sponsored_message_id: campaign.id,
          scheduled_for: campaign.scheduled_for,
        },
      },
      data: { chat_message_id: created.id },
    }),
  ])

  await emit(groupId, {
    id: created.id,
    content: created.content,
    type,
    createdAt: created.created_at.toISOString(),
    userId: event.organizer_id,
  })

  await finalize(campaign, token, now)
  return "sent"
}

/**
 * Who was in the room, counted and hashed.
 *
 * `active` and `muted` only — `left` rows are kept because the pseudonym lives
 * on them, and counting them is what made an earlier "blast radius" figure grow
 * all night as people went home. Same rule as `lib/room-audience.ts`.
 */
async function roomSnapshot(
  groupId: string,
  campaignId: string
): Promise<{ members: number; connected: number; hashes: string[] }> {
  const members = await db.chat_group_members.findMany({
    where: { chat_group_id: groupId, status: { in: ["active", "muted"] } },
    select: { user_id: true },
  })

  /*
   * Hashed per campaign, never stored raw. Two sends thirty minutes apart with
   * raw ids yield arrival and departure per person, and intersecting them across
   * a campaign spanning several events identifies whoever attends everything.
   * Per-campaign salt keeps `count(distinct)` exact — all the report needs —
   * while making the array useless for correlation.
   */
  const hashes = members.map((m) => attendeeLabel(m.user_id, campaignId))

  return { members: members.length, connected: await connected(groupId), hashes }
}

/** Sockets in the room, or 0 if the adapter cannot answer. */
async function connected(groupId: string): Promise<number> {
  try {
    const { socketsInChatRoom } = await import("./socket-server")
    return (await socketsInChatRoom(groupId)) ?? 0
  } catch {
    /*
     * `live_connected` is `Int` and not null, so unlike `roomAudience` this
     * cannot report "unknown". Zero is the honest floor: it is labelled "live
     * connected" and undercounting is the safe direction for a number a sponsor
     * reads.
     */
    return 0
  }
}

async function emit(
  groupId: string,
  message: { id: string; content: string; type: string; createdAt: string; userId: string }
): Promise<void> {
  try {
    const { emitChatMessage } = await import("./socket-server")
    emitChatMessage(groupId, {
      id: message.id,
      content: message.content,
      // The persisted type, not a hardcoded "text". A socket listener that is
      // told "text" renders a caption and drops the artwork the sponsor paid
      // for, and only a page refresh reveals the difference.
      type: message.type,
      userId: message.userId,
      userName: "Sponsored",
      createdAt: message.createdAt,
    })
  } catch (error) {
    /*
     * The message is already persisted, so a failed emit costs a live refresh
     * and nothing else. Failing the send here would roll the schedule back and
     * repeat a message that is already in the room.
     */
    logger.warn("Could not emit sponsored message", {
      groupId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The first window for a campaign being switched on.
 *
 * `now`, not `now + interval`: the organiser flipped the switch because they
 * want it running. An interval of silence first reads as a broken control, which
 * is what `start()` having no leading edge produced.
 */
export function firstWindow(now: Date = new Date()): Date {
  return now
}

let timer: NodeJS.Timeout | null = null

/**
 * Self-scheduling rather than `setInterval`, so a slow pass cannot overlap the
 * next one. Same reasoning as the presence and chat-lifecycle sweepers.
 */
export function startSponsoredScheduler(): void {
  if (timer) return
  const run = async () => {
    try {
      await sweepSponsored()
    } catch (error) {
      // A failed pass must not take the process down or stop the loop. Every
      // claim it took expires on its own after LEASE_MINUTES.
      logger.error("Sponsored sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      timer = setTimeout(run, SWEEP_INTERVAL_MS)
    }
  }
  timer = setTimeout(run, SWEEP_INTERVAL_MS)
}

export function stopSponsoredScheduler(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
