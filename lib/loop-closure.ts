// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { Prisma } from "@prisma/client"

import { ATTENDED } from "./counting"
import { db } from "./db"

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
      SELECT user_id, event_id
      FROM event_check_ins
      WHERE status::text IN (${Prisma.join(ATTENDED)})
        AND kind = 'attendee'
    ),
    /*
     * A match is a mutual pair of likes at one event. There is no matches
     * table -- the mutual check is done on every like and never stored -- so it
     * is a self-join, and the pair is unordered.
     */
    matched AS (
      SELECT DISTINCT l.liker_id AS user_id
      FROM event_likes l
      JOIN event_likes back
        ON back.event_id = l.event_id
       AND back.liker_id = l.liked_id
       AND back.liked_id = l.liker_id
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
      COUNT(*) FILTER (WHERE s_onboarded AND s_rsvpd AND s_checked_in AND s_matched AND s_conversed AND s_returned)
                                                                   AS returned
    FROM stages
  `

  const n = (v: bigint | undefined) => Number(v ?? 0)
  return [
    { label: "signed up", value: n(row?.signed_up) },
    { label: "onboarded", value: n(row?.onboarded) },
    { label: "RSVP'd", value: n(row?.rsvpd) },
    { label: "checked in", value: n(row?.checked_in) },
    { label: "matched", value: n(row?.matched) },
    { label: "conversed", value: n(row?.conversed) },
    { label: "came back", value: n(row?.returned) },
  ]
}
