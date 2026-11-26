import type { PrismaClient, venue_type } from "@prisma/client"

import type { Geofence, LatLng } from "../lib/geofence"

// RED stub (SCRUM-1150): the signatures the tests call, doing nothing.
export const PILOT_VENUE_ID = "0fbaa05a-2d36-45fc-8066-82742636044c"
export interface Candidate { building: string; dataset: string; cls: string | null; geometry: unknown }
export type Pick =
  | { ok: true; fence: Geofence; building: string; dataset: string; how: "contained" | "nearest" }
  | { ok: false; reason: "none" | "unusable_ring" | "too_big_for_type" }
export interface FenceRow { id: string; was: unknown; fence: Geofence; building: string; dataset: string; how: string }
export interface RollbackRow { id: string; previous: unknown; written: unknown }
export interface RollbackFile { release: string; rows: RollbackRow[] }

export function fenceFromCandidates(_pin: LatLng, _type: venue_type | null, _candidates: Candidate[]): Pick {
  return { ok: false, reason: "none" }
}
export function readExclude(_args: string[]): Set<string> {
  return new Set()
}
export async function exportVenues(_db: PrismaClient): Promise<{ id: string }[]> {
  return []
}
export async function applyFences(
  _db: PrismaClient,
  _file: { release: string; rows: FenceRow[] },
  _opts: { write: boolean; exclude: Set<string>; rollbackPath: string; batch?: number }
): Promise<RollbackRow[]> {
  return []
}
export async function revertFences(_db: PrismaClient, _file: RollbackFile, _opts: { write: boolean }): Promise<string[]> {
  return []
}
