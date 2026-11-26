// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { Prisma } from "@prisma/client"

import { ATTENDED } from "./counting"
import { db } from "./db"
import { SYSTEM_USER_ID } from "./event-kind"
import { ACQUISITION_SOURCES, type AcquisitionSource } from "./product-events"

/**
 * The loop, closed or not: signed up → onboarded → RSVP'd → checked in →
 * matched → conversed → came back.
 *
 * ## Why this is the number
 *
 * The product's one sentence is "a way to approach someone without risking
 * rejection". Every stage before `checked in` is measurable by any events app.
 * The last three are not, because they require **verified physical
 * attendance**, and nobody else has it. This is the only figure in the product
 * that says whether the thesis holds.
 *
 * The dashboard has had the first four stages for a while and stopped exactly
 * where the interesting part starts.
 *
 * ## Nested subsets, or the shape lies
 *
 * Each stage filters on the one above it. An earlier version of the first four
 * counted independent populations and drew them as a funnel — staging showed
 * 7 onboarded and 10 RSVP'd, because you can RSVP without onboarding, and the
 * chart widened downward. The same trap is waiting in the new stages: plenty of
 * people have a conversation without ever matching at an event, because
 * accepted message requests and board requests both open one.
 *
 * ## One query, not seven
 *
 * The admin overview already fires roughly 28 round trips in four dependent
 * waves. Seven counts, each a superset scan of the last, would be seven more —
 * so the stages are one `FILTER` aggregate over a single pass.
 *
 * ## Distinct people, and distinct events
 *
 * `returned` is `COUNT(DISTINCT event_id) >= 2`, never a row count. One person
 * at one three-day conference has three check-in rows, and counting those made
 * them a returning attendee — the defect W17 fixed in nine places and the one
 * this table invites again every time somebody counts it fresh.
 */
export interface LoopStage {
  label: string
  value: number
  /** The stage this one is a share of, when it is not the one above it. */
  base?: string
}

export async function loopClosure(): Promise<LoopStage[]> {
  /*
   * `attended` is the shared definition of having turned up: an attendee-kind
   * check-in in a status that means they were there. Taken from
   * `lib/counting.ts` rather than restated, because a funnel that disagrees
   * with the turn-up number on the next screen is worse than either alone.
   */
  const [row] = await db.$queryRaw<
    Array<Record<"signed_up" | "onboarded" | "rsvpd" | "checked_in" | "matched" | "conversed" | "returned", bigint>>
  >`
    WITH attended AS (
      -- Events only: going live at a venue is not a night anybody hosted, and
      -- two go-lives would read as "came back" (step 3).
      SELECT c.user_id, c.event_id
      FROM event_check_ins c
      JOIN events e ON e.id = c.event_id AND e.kind = 'event'
      WHERE c.status::text IN (${Prisma.join(ATTENDED)})
        AND c.kind = 'attendee'
    ),
    /*
     * A match is the conversation it opened: cameFromMatch in SQL (a
     * pseudonym snapshotted, no Lobby ask behind it). Never the waves or likes
     * themselves, which are purged 30 days after the event
     * (purgeEventGestures) and would take the stage down with them.
     */
    matched AS (
      SELECT u.user_id FROM private_conversations c
      CROSS JOIN LATERAL (VALUES (c.user1_id), (c.user2_id)) AS u(user_id)
      WHERE (c.user1_pseudonym IS NOT NULL OR c.user2_pseudonym IS NOT NULL)
        AND c.origin_board_request_id IS NULL
    ),
    /*
     * Conversed is a message SENT, not a conversation existing. A match that
     * opens a conversation neither person writes in has not closed the loop,
     * and counting the row would say it had.
     */
    conversed AS (
      SELECT DISTINCT sender_id AS user_id FROM private_messages
    ),
    returned AS (
      SELECT user_id FROM attended GROUP BY user_id HAVING COUNT(DISTINCT event_id) >= 2
    ),
    stages AS (
      SELECT
        u.id,
        (p.onboarded IS TRUE)                                          AS s_onboarded,
        EXISTS (SELECT 1 FROM event_rsvps r WHERE r.user_id = u.id)    AS s_rsvpd,
        EXISTS (SELECT 1 FROM attended a WHERE a.user_id = u.id)       AS s_checked_in,
        EXISTS (SELECT 1 FROM matched m WHERE m.user_id = u.id)        AS s_matched,
        EXISTS (SELECT 1 FROM conversed c WHERE c.user_id = u.id)      AS s_conversed,
        EXISTS (SELECT 1 FROM returned t WHERE t.user_id = u.id)       AS s_returned
      FROM "User" u
      LEFT JOIN profiles p ON p.id = u.id
      WHERE u."deletedAt" IS NULL
        -- The owner of every venue day signed up for nothing.
        AND u.id <> ${SYSTEM_USER_ID}
    )
    SELECT
      COUNT(*)                                                     AS signed_up,
      COUNT(*) FILTER (WHERE s_onboarded)                          AS onboarded,
      COUNT(*) FILTER (WHERE s_onboarded AND s_rsvpd)              AS rsvpd,
      COUNT(*) FILTER (WHERE s_onboarded AND s_rsvpd AND s_checked_in)
                                                                   AS checked_in,
      COUNT(*) FILTER (WHERE s_onboarded AND s_rsvpd AND s_checked_in AND s_matched)
                                                                   AS matched,
      COUNT(*) FILTER (WHERE s_onboarded AND s_rsvpd AND s_checked_in AND s_matched AND s_conversed)
                                                                   AS conversed,
      -- Coming back is attending a second event; it does not wait on a match
      -- or a conversation (the owner's ruling, SCRUM-313).
      COUNT(*) FILTER (WHERE s_onboarded AND s_rsvpd AND s_checked_in AND s_returned)
                                                                   AS returned
    FROM stages
  `

  const n = (v: bigint | undefined) => Number(v ?? 0)
  return [
    { label: "signed up", value: n(row?.signed_up) },
    { label: "onboarded", value: n(row?.onboarded) },
    { label: "RSVP’d", value: n(row?.rsvpd) },
    { label: "checked in", value: n(row?.checked_in) },
    // Right after the stage it is a share of. It sat under `conversed`, so three
    // people who had come back read as none because none of them had matched.
    { label: "came back", value: n(row?.returned) },
    { label: "matched", value: n(row?.matched), base: "checked in" },
    { label: "conversed", value: n(row?.conversed) },
  ]
}

/**
 * A stage of a signup cohort: how many reached it, out of how many have had
 * the whole window. Null when nobody has — "not yet known", never a low number.
 */
export type CohortStage = { count: number; of: number } | null

export interface CohortRow {
  signedUp: number
  rsvp7: CohortStage
  checkIn14: CohortStage
  back30: CohortStage
}

/**
 * The app's onboarding steps, in its order (SCRUM-1283). Mirrors `ONBOARDING_STEPS` and `STEP_FIELDS` in the client's
 * `lib/onboarding.ts` (blendn origin/dev f16c3125), less `ready`, which writes nothing but `onboarded`. There are no
 * per-step routes: each step PUTs its own fields to the one profile route, so how far somebody got is what they filled.
 */
export const ONBOARDING_STEPS = ["basics", "preferences", "details", "media", "location"] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/**
 * What each step leaves behind, read from the profile `p` of the person `u`. Only a filled field is evidence:
 *
 * - basics: `name` is sign-up's (every sign-up route writes it), so it is the birth date the step requires, or gender.
 * - preferences: `show_orientation` and `reveal_by_default` default to false, so only true says the step was answered.
 * - details: the interest graph (`user_interests`, synced before the PUT) counts as much as the free-text names.
 * - location: `share_location` defaults to true, so only a no is readable; a yes reads as the step before.
 *
 * A NULL (no profile row) is not true, so a person with none reads as nothing filled.
 */
const STEP_FILLED: Record<OnboardingStep, Prisma.Sql> = {
  basics: Prisma.sql`p.date_of_birth IS NOT NULL OR p.gender IS NOT NULL`,
  preferences: Prisma.sql`cardinality(p.intent_default) > 0 OR cardinality(p.orientations) > 0 OR p.show_orientation OR p.reveal_by_default`,
  details: Prisma.sql`cardinality(p.interests) > 0 OR p.bio <> '' OR EXISTS (SELECT 1 FROM user_interests ui WHERE ui.user_id = u.id)`,
  media: Prisma.sql`cardinality(p.photos) > 0`,
  location: Prisma.sql`p.share_location = false`,
}

/** Finished first, then the furthest step filled: a skipped step does not hold anybody back. */
const FURTHEST_STEP = Prisma.sql`CASE WHEN p.onboarded THEN 'finished' ${Prisma.join(
  [...ONBOARDING_STEPS].reverse().map((step) => Prisma.sql`WHEN ${STEP_FILLED[step]} THEN ${step}`),
  " ",
)} ELSE 'none' END`

export type StepRow = { step: "none" | OnboardingStep | "finished"; people: number }

export interface SignupCohorts {
  /** Newest first. `week` is the Monday of an ISO week in India's calendar, YYYY-MM-DD. */
  weeks: Array<CohortRow & { week: string }>
  /** Every source with anybody, in `ACQUISITION_SOURCES` order, then "unknown". */
  sources: Array<CohortRow & { source: AcquisitionSource | "unknown" }>
  /**
   * The same people by the furthest onboarding step they filled: nothing, each step in the app's order, then finished.
   * Every row, zeros included; together they are the weeks' sign-ups.
   */
  steps: StepRow[]
}

const COUNT_KEYS = ["signed_up", "of7", "rsvp7", "of14", "checkin14", "of30", "back30"] as const
type CohortCounts = Record<(typeof COUNT_KEYS)[number], number>

/**
 * Sign-ups by week (SCRUM-1281): of the people who signed up in each of the
 * last `weeks` ISO weeks, who RSVP'd within 7 days, checked in within 14, and
 * came to a second distinct event within 30; the same by `signup_source`; and the same people by the
 * furthest onboarding step they filled (SCRUM-1283, `STEP_FILLED`).
 *
 * `loopClosure` above cannot say any of this: it has no dates, and its "came
 * back" has no time bound.
 *
 * ## Independent stages, not nested
 *
 * Each stage is a share of the cohort, not of the stage before it. The door
 * QR is the launch's install path, and somebody who signs up at the door and
 * checks in never RSVPs: nesting would hide exactly the people the launch is
 * betting on. A table draws no narrowing shape, so the funnel's reason to nest
 * does not apply.
 *
 * ## Not yet known is not zero
 *
 * A stage counts only people whose own window has closed (`of`). A week's
 * stage is shown only once that is everybody in the week; a source's stage is
 * a share of those people, and null while there are none.
 *
 * ## Bounded
 *
 * The cohort is read off `User_createdAt_idx` for the weeks asked; each
 * person's RSVPs and check-ins by `user_id`. The same `ATTENDED`, event-kind
 * and system-user rules as `loopClosure`, so the two never disagree about who
 * turned up.
 */
export async function signupCohorts(weeks = 8, now: Date = new Date()): Promise<SignupCohorts> {
  const rows = await db.$queryRaw<
    Array<{ week: string; source: string | null; step: StepRow["step"] | null } & Record<(typeof COUNT_KEYS)[number], bigint>>
  >`
    WITH weeks AS (
      SELECT generate_series(
        date_trunc('week', ${now}::timestamptz AT TIME ZONE 'Asia/Kolkata') - make_interval(weeks => ${weeks - 1}::int),
        date_trunc('week', ${now}::timestamptz AT TIME ZONE 'Asia/Kolkata'),
        interval '1 week'
      ) AS week
    ),
    cohort AS (
      -- "createdAt" is a timestamp without time zone, written in UTC.
      SELECT u.id, u."createdAt" AT TIME ZONE 'UTC' AS joined, p.signup_source AS source, ${FURTHEST_STEP} AS step
      FROM "User" u
      LEFT JOIN profiles p ON p.id = u.id
      WHERE u."deletedAt" IS NULL
        AND u.id <> ${SYSTEM_USER_ID}
        -- The first week spelled out, not read from the weeks CTE: the planner can size a constant, not an InitPlan.
        AND u."createdAt" >= ((date_trunc('week', ${now}::timestamptz AT TIME ZONE 'Asia/Kolkata') - make_interval(weeks => ${weeks - 1}::int)) AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC'
        AND u."createdAt" <= ${now}::timestamptz AT TIME ZONE 'UTC'
    ),
    person AS (
      SELECT
        date_trunc('week', c.joined AT TIME ZONE 'Asia/Kolkata') AS week,
        c.source,
        c.step,
        c.joined + interval '7 days'  <= ${now}::timestamptz AS known7,
        c.joined + interval '14 days' <= ${now}::timestamptz AS known14,
        c.joined + interval '30 days' <= ${now}::timestamptz AS known30,
        EXISTS (
          SELECT 1 FROM event_rsvps r WHERE r.user_id = c.id AND r.created_at < c.joined + interval '7 days'
        ) AS rsvp7,
        COALESCE(a.events14, 0) > 0  AS checkin14,
        COALESCE(a.events30, 0) >= 2 AS back30
      FROM cohort c
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT ci.event_id) FILTER (WHERE COALESCE(ci.check_in_time, ci.created_at) < c.joined + interval '14 days') AS events14,
          COUNT(DISTINCT ci.event_id) AS events30
        FROM event_check_ins ci
        -- Events only: going live at a venue is not a night anybody hosted.
        JOIN events e ON e.id = ci.event_id AND e.kind = 'event'
        WHERE ci.user_id = c.id
          AND ci.kind = 'attendee'
          AND ci.status::text IN (${Prisma.join(ATTENDED)})
          AND COALESCE(ci.check_in_time, ci.created_at) < c.joined + interval '30 days'
      ) a ON true
    )
    SELECT
      to_char(w.week, 'YYYY-MM-DD')                    AS week,
      p.source,
      p.step,
      COUNT(p.week)                                     AS signed_up,
      COUNT(*) FILTER (WHERE p.known7)                  AS of7,
      COUNT(*) FILTER (WHERE p.known7 AND p.rsvp7)      AS rsvp7,
      COUNT(*) FILTER (WHERE p.known14)                 AS of14,
      COUNT(*) FILTER (WHERE p.known14 AND p.checkin14) AS checkin14,
      COUNT(*) FILTER (WHERE p.known30)                 AS of30,
      COUNT(*) FILTER (WHERE p.known30 AND p.back30)    AS back30
    FROM weeks w
    LEFT JOIN person p ON p.week = w.week
    GROUP BY w.week, p.source, p.step
  `

  const parts = rows.map((r) => ({
    week: r.week,
    step: r.step,
    source: (ACQUISITION_SOURCES as readonly (string | null)[]).includes(r.source) ? (r.source as AcquisitionSource) : null,
    ...(Object.fromEntries(COUNT_KEYS.map((k) => [k, Number(r[k])])) as CohortCounts),
  }))
  const sum = (group: CohortCounts[]) =>
    Object.fromEntries(COUNT_KEYS.map((k) => [k, group.reduce((n, g) => n + g[k], 0)])) as CohortCounts
  const row = (c: CohortCounts, whole: boolean): CohortRow => {
    // A week is shown only when everybody in it has had the window; a source as soon as anybody has.
    const stage = (count: number, of: number): CohortStage => (of === 0 || (whole && of < c.signed_up) ? null : { count, of })
    return {
      signedUp: c.signed_up,
      rsvp7: stage(c.rsvp7, c.of7),
      checkIn14: stage(c.checkin14, c.of14),
      back30: stage(c.back30, c.of30),
    }
  }

  const weekKeys = [...new Set(parts.map((p) => p.week))].sort().reverse()
  const sourceKeys = [...ACQUISITION_SOURCES, null]
  return {
    weeks: weekKeys.map((week) => ({ week, ...row(sum(parts.filter((p) => p.week === week)), true) })),
    sources: sourceKeys
      .map((source) => ({ source: source ?? ("unknown" as const), counts: sum(parts.filter((p) => p.source === source)) }))
      .filter(({ counts }) => counts.signed_up > 0)
      .map(({ source, counts }) => ({ source, ...row(counts, false) })),
    steps: (["none", ...ONBOARDING_STEPS, "finished"] as const).map((step) => ({
      step,
      people: sum(parts.filter((p) => p.step === step)).signed_up,
    })),
  }
}
