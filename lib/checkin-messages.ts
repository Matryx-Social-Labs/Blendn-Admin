/**
 * What a refused check-in says, when the distance stops being walkable.
 *
 * The sentence was built for the near case and only the near case:
 *
 *     `You're about ${Math.round(verdict.shortfall)}m outside the check-in area.
 *      Move closer to the venue and try again.`
 *
 * At 45m that is exactly right — a number you can act on and an action that
 * works. Driven from Saarbrücken against a Bengaluru event, it produced:
 *
 *     You're about 7514501m outside the check-in area. Move closer to the venue
 *     and try again.
 *
 * Seven digits of metres, and advice that is wrong: nobody walks 7,514km closer.
 * The far case is not rare either — it is the wrong city, a lost fix, or an
 * event bookmarked from home, which is most of the ways this refusal is ever
 * seen.
 *
 * Two bands, because there are two situations and they want different sentences,
 * not one sentence stretched across both. The client renders this verbatim and
 * deliberately — `lib/checkInRefusal.ts` there says "the number belongs to the
 * server" — so the phrasing has to be right here or it is wrong on the phone.
 */

/**
 * Below this, the metre count is actionable and "move closer" is true advice.
 * A kilometre is roughly a twelve-minute walk; past that the number stops being
 * something you close on foot.
 */
export const WALKABLE_SHORTFALL_METRES = 1000

export function outOfRangeMessage(shortfallMetres: number): string {
  const metres = Math.round(shortfallMetres)

  if (metres < WALKABLE_SHORTFALL_METRES) {
    /*
     * Unchanged, to the character. The client's `checkInRefusal` test asserts
     * this exact sentence at 45m, and the whole point of that test is that the
     * client once tried to build its own and got it wrong.
     */
    return `You're about ${metres}m outside the check-in area. Move closer to the venue and try again.`
  }

  /*
   * Kilometres, and no "try again" — retrying from the same place cannot work,
   * so offering it is the failure mode the near sentence avoids by being
   * specific. Rounded to whole kilometres: a decimal on a 7,515km figure is
   * precision nobody asked for.
   */
  const km = Math.round(metres / 1000)
  return `You're about ${km}km from the venue, so check-in isn't available yet. Check in once you're there.`
}
