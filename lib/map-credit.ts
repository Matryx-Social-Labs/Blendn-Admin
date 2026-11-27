/**
 * The check-in area editor's map credit (SCRUM-1147, SCRUM-1317).
 *
 * The tiles are OpenStreetMap's, and OSM asks for a credit linked to its
 * copyright page. A seeded venue's outline may come from Overture buildings
 * (ODbL, OSM inside; `scripts/backfill-venue-fences.ts`), which asks for its own
 * line, and nothing records which fence came from there, so every editor map
 * carries both. Overture's link goes to the page that carries each source's own
 * credit (Google Open Buildings, Microsoft, City of Vancouver): the licence
 * table is in `scripts/places/README.md`. New tabs, because the map sits in an
 * unsaved form.
 */
export const MAP_CREDIT =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" aria-label="OpenStreetMap copyright (opens in a new tab)">OpenStreetMap</a> contributors, ' +
  '<a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noopener noreferrer" aria-label="Overture Maps Foundation attribution (opens in a new tab)">Overture Maps Foundation</a>'
