/**
 * Strings that appear on an admin screen only when its seeded rows rendered.
 *
 * Written by `scripts/seed-admin-world.ts`, read by `e2e/access-matrix.spec.ts`
 * — one constant, so the seed and the check cannot drift apart. A module of its
 * own because the spec must not import the seed (which opens a database).
 */
export const MATRIX_MARKERS = {
  // A lead from an address that has also applied: the drawer's "Already applied".
  lead: "founder@thehummingtree.com",
  report: "Kept messaging after being asked to stop",
  creative: "Pour-over flight at the bar from 8pm",
  category: "Classical and Carnatic",
} as const
