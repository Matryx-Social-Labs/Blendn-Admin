/*
 * For a suite whose mocked `@/lib/db` has no `markets` or `cities` and whose subject
 * is not the catalogue: no city is catalogued, so the city rule is the plain string match.
 * `jest.mock("@/lib/cities", () => jest.requireActual("./support/empty-catalogue"))`
 */
const actual = jest.requireActual<typeof import("@/lib/cities")>("@/lib/cities")
const empty = actual.buildCatalogue([], [])

export const cityFor = actual.cityFor
export const citySlugFor = actual.citySlugFor
export const cityCatalogue = async () => empty
export const previewMarketsFor = async () => new Set<string>()
