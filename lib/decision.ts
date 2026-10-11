import { z } from "zod"

import { Refusal } from "./refusal"

/**
 * An admin's decision, checked the way every decide-action in the dashboard
 * checks it (step 18 security review, H1 and M2).
 *
 * - The decision is one of the words the action takes, validated before
 *   anything else runs. A server action's argument is whatever the client
 *   sent: `"bogus"` used to fall through every `decision === "approve"` and
 *   land as the other outcome, past the reason check that guards it.
 * - A decline or a rejection carries a reason of at least ten characters,
 *   because it is sent to the person it is about, and one with no reason
 *   produces an identical re-file.
 * - The write that records the decision is conditional on the row still being
 *   undecided (`updateMany … where status is pending`), and a count other than
 *   one is `ALREADY_DECIDED`. A read-then-write is not a lock: two admins with
 *   the queue open both read "pending" and both commit.
 *
 * Plain module, not `"use server"`: it is imported by the actions.
 */

/** What the second of two racing decisions is told. */
export const ALREADY_DECIDED = "Someone else decided this."

/** The shortest reason a decline may carry. */
export const MIN_REASON_LENGTH = 10

/** `value` as one of `allowed`, or a Refusal naming nothing about the input. */
export function decisionFrom<const T extends readonly [string, ...string[]]>(allowed: T, value: unknown): T[number] {
  const parsed = z.enum(allowed).safeParse(value)
  if (!parsed.success) throw new Refusal("That is not a decision this queue takes.")
  return parsed.data
}

/**
 * The reason, trimmed: required (at least `MIN_REASON_LENGTH` characters) when
 * `required`, otherwise kept if given. Anything but a string is no reason.
 */
export function reasonFrom(value: unknown, required: boolean, refusal = "Give a reason — it is sent to the person it is about."): string | null {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (required && trimmed.length < MIN_REASON_LENGTH) throw new Refusal(refusal)
  return trimmed || null
}

/** The guard on the write that records a decision: exactly one undecided row changed. */
export function refuseUnlessDecided(count: number): void {
  if (count !== 1) throw new Refusal(ALREADY_DECIDED)
}

/**
 * Postgres aborted this transaction to break a lock cycle or a write conflict
 * (Prisma P2034): another decision held what this one needed and went first.
 * A backstop — the decide-actions take their locks in one order — so the loser
 * is told the same sentence as any other race, not "Something went wrong".
 */
export function isWriteConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2034"
}
