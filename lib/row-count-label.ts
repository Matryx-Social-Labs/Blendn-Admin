/**
 * What the footer of a capped table says.
 *
 * `page.tsx` fetches 50 users and passes the real `total` alongside; the table
 * declared that prop and read it nowhere, so a view of 50 of 120 accounts said
 * only *"50 row(s) selected"* and looked complete. That is the *no silent caps*
 * rule, unapplied to the screen it was written for.
 *
 * A pure function rather than an expression in the JSX, because the first guard
 * written for this was a substring check and **passed against
 * `{false && data.length < total}`** — the assertion saw the text and not the
 * behaviour. A function has arguments a test can vary, which is the difference
 * between checking that a rule is written down and checking that it holds.
 */
export function rowCountLabel({
  shown,
  total,
  searching,
  selected,
  onPage,
}: {
  shown: number
  total: number
  searching: boolean
  selected: number
  onPage: number
}): string {
  if (shown < total) {
    /*
     * "matching" only when a search is running, because "showing 12 of 120"
     * during a search would read as the cap rather than as the result count —
     * and the advice to narrow is useless if you have not searched yet.
     */
    const scope = searching ? " matching" : ""
    const advice = searching ? "" : " — search to reach the rest"
    return `Showing ${shown} of ${total}${scope}${advice}.`
  }
  return `${selected} of ${onPage} row(s) selected.`
}
