/**
 * A venue's floors as the app's 3D map turns them into height (owner,
 * 2026-10-09). 3.66 m a floor is OpenMapTiles' own rule for a building with
 * `building:levels` and no height (`levels * 3.66`), which the map's basemap
 * already applies, so an override reads like the buildings around it.
 *
 * Client-safe: no database. The dashboard's hint and docs/API.md say the same.
 */
export const METRES_PER_FLOOR = 3.66

/** The height the map draws for this many floors, to the metre. */
export function floorsHeightMetres(floors: number): number {
  return Math.round(floors * METRES_PER_FLOOR)
}
