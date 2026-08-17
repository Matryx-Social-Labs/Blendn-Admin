/**
 * What a merge has to repoint.
 *
 * A plain module, not part of `lib/sponsor-actions.ts`, for a reason the build
 * enforces: a `"use server"` file may only export async functions. A `const` or
 * a sync function in one compiles, typechecks and unit-tests clean, then fails
 * at `next build` with "can only export async functions, found object" — which
 * is how this list and a re-exported `isSameSponsorName` sat in that file
 * breaking the production build while `tsc`, `jest` and `eslint` all passed.
 *
 * `__tests__/sponsor-merge-coverage.test.ts` asserts this equals the set of
 * back-relations declared on `model sponsors`, so a future foreign key cannot be
 * added without being handled: a campaign left pointing at a merged-away brand
 * either fails the `sponsored_active_needs_sponsor` check the moment the loser is
 * soft-deleted, or keeps sending under a brand that no longer exists.
 */
export const MERGE_REPOINTS = [
  "event_sponsors",
  "event_sponsored_messages",
  "sponsor_claims",
] as const
