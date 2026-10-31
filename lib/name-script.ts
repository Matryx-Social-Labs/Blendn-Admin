import { Refusal } from "@/lib/refusal"

/*
 * SCRUM-959: a Cyrillic "і" in "Third Wave" is the same picture and a different
 * name key, so the uniqueness check cannot see the lookalike. Rather than ship
 * a confusables table, refuse a name that mixes the scripts whose letters pass
 * for Latin ones. CJK, Arabic and the like next to Latin are not lookalikes and
 * stay allowed; a name written wholly in one alphabet is never refused.
 * ponytail: a whole word in another script ("Аррlе" all Cyrillic) is a single-
 * script name and passes; that needs the UTS #39 skeleton, a separate call.
 */
const LOOKALIKE_SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Cherokee}/u,
  /\p{Script=Coptic}/u,
  /\p{Script=Canadian_Aboriginal}/u,
  /\p{Script=Lisu}/u,
]

export const hasMixedScripts = (name: string): boolean =>
  LOOKALIKE_SCRIPTS.filter((script) => script.test(name)).length > 1

export function refuseMixedScript(name: string): void {
  if (hasMixedScripts(name)) {
    throw new Refusal("Use one alphabet in the name: it mixes letters that look alike, such as Latin and Cyrillic.")
  }
}
