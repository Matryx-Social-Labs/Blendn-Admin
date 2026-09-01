/**
 * Comment text is not code, and a grep over raw source cannot tell.
 *
 * Both of the greps in this suite are wrong in opposite directions without
 * this. `authz-scoping-boundary` explains the `organizer_id !==` bug in prose
 * at several call sites, so a naive match fails on correct code. And
 * `server-actions-reachable` counts a name as reachable if any file mentions
 * it, so a function whose only mention anywhere is one line of a comment —
 * `escalates` was exactly this — reads as fully wired up. The second is the
 * worse failure: a reachability check that counts a mention converts an
 * unknown into a false assurance.
 *
 * Shared rather than copied because the two copies must agree. A stricter
 * version in one file and a looser one in the other is how a grep-based
 * boundary quietly stops meaning what its docblock says.
 *
 * Known limit: `//` inside a string literal (a URL) truncates the rest of that
 * line. Neither caller matches on anything that can appear after `https:` in a
 * URL, so it costs nothing here and a real tokeniser is not worth its weight.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}
