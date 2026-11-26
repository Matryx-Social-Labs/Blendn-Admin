import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  PILOT_VENUE_ID,
  applyFences,
  exportVenues,
  revertFences,
  type FenceRow,
  type RollbackFile,
} from "../../scripts/backfill-venue-fences"
import { closeDb, db, testId } from "./helpers"

/*
 * SCRUM-1150 (04a). The backfill writes a building outline onto a seeded venue nobody has claimed and nobody has
 * drawn, and onto nothing else. The scope is the provenance check (no column, no Json key), so it is repeated in the
 * UPDATE itself: a venue claimed or edited between the export and the apply is skipped, a second apply changes
 * nothing, and the rollback file puts back exactly what it replaced.
 */
const circle = (lat: number, lng: number, radius = 30) => ({ type: "circle", lat, lng, radius, buffer: 20 })
const lat = 12.4 + Math.random() * 0.05
const lng = 77.1 + Math.random() * 0.05
const polygonOf = (d: number) => ({
  type: "polygon",
  ring: [[lat - d, lng - d], [lat - d, lng + d], [lat + d, lng + d], [lat + d, lng - d]],
  buffer: 20,
})
const building = polygonOf(0.0001)

const venues: string[] = []
const dir = mkdtempSync(join(tmpdir(), "fences-itest-"))

async function venue(label: string, data: Record<string, unknown>) {
  const v = await db.venues.create({
    data: {
      name: testId(label),
      latitude: lat,
      longitude: lng,
      source: "overture:2026-11-18.0",
      venue_type: "cafe",
      geofence: circle(lat, lng),
      ...data,
    },
  })
  venues.push(v.id)
  return v.id
}

const fenceOf = async (id: string) => (await db.venues.findUniqueOrThrow({ where: { id } })).geofence
const rowFor = async (id: string): Promise<FenceRow> => ({
  id,
  was: await fenceOf(id),
  fence: building as FenceRow["fence"],
  building: `gers-${id}`,
  dataset: "OpenStreetMap",
  how: "contained",
})
const file = (rows: FenceRow[]) => ({ release: "2026-11-18.0", rows })

afterAll(async () => {
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  rmSync(dir, { recursive: true, force: true })
  await closeDb()
})

describe("the export reads only the scope", () => {
  it("lists a seeded, unclaimed circle or fence-less venue, and no claimed, drawn, deleted or hand-added one", async () => {
    const inScope = await venue("export-in", {})
    const bare = await venue("export-bare", { geofence: undefined })
    const claimed = await venue("export-claimed", { claimed_at: new Date() })
    const drawn = await venue("export-drawn", { geofence: building })
    const deleted = await venue("export-deleted", { deleted_at: new Date() })
    const handAdded = await venue("export-hand", { source: null })
    const ids = new Set((await exportVenues(db)).map((v) => v.id))
    expect([inScope, bare].every((id) => ids.has(id))).toBe(true)
    expect([claimed, drawn, deleted, handAdded].some((id) => ids.has(id))).toBe(false)
  })
})

describe("apply", () => {
  let inScope: string, bare: string, claimed: string, drawn: string, deleted: string, excluded: string, raced: string
  let rows: FenceRow[]
  let rollbackPath: string

  beforeAll(async () => {
    inScope = await venue("in", {})
    bare = await venue("bare", { geofence: undefined })
    excluded = await venue("excluded", {})
    raced = await venue("raced", {})
    // As exported, then claimed, outlined by hand or deleted before the apply.
    claimed = await venue("claimed", {})
    drawn = await venue("drawn", {})
    deleted = await venue("deleted", {})
    rows = await Promise.all([inScope, bare, excluded, raced, claimed, drawn, deleted].map(rowFor))
    await db.venues.update({ where: { id: claimed }, data: { claimed_at: new Date() } })
    await db.venues.update({ where: { id: drawn }, data: { geofence: polygonOf(0.0003) } })
    await db.venues.update({ where: { id: deleted }, data: { deleted_at: new Date() } })
    // Edited between the export and the apply: the circle moved with its pin.
    await db.venues.update({ where: { id: raced }, data: { geofence: circle(lat + 0.001, lng) } })
  })

  it("a dry run writes nothing and says what it would change", async () => {
    const before = await Promise.all(rows.map((r) => fenceOf(r.id)))
    const path = join(dir, "dry.json")
    const done = await applyFences(db, file(rows), { write: false, exclude: new Set([excluded]), rollbackPath: path, batch: 2 })
    expect(done.map((r) => r.id).sort()).toEqual([inScope, bare].sort())
    expect(await Promise.all(rows.map((r) => fenceOf(r.id)))).toEqual(before)
    expect((JSON.parse(readFileSync(path, "utf8")) as RollbackFile).rows).toHaveLength(2)
  })

  it("writes the outline only where the venue is still in scope and as exported", async () => {
    const claimedBefore = await fenceOf(claimed)
    const drawnBefore = await fenceOf(drawn)
    const racedBefore = await fenceOf(raced)
    rollbackPath = join(dir, "apply.json")
    const done = await applyFences(db, file(rows), { write: true, exclude: new Set([excluded]), rollbackPath, batch: 2 })

    expect(done.map((r) => r.id).sort()).toEqual([inScope, bare].sort())
    expect(await fenceOf(inScope)).toEqual(building)
    expect(await fenceOf(bare)).toEqual(building)
    expect(await fenceOf(claimed)).toEqual(claimedBefore)
    expect(await fenceOf(drawn)).toEqual(drawnBefore)
    expect(await fenceOf(raced)).toEqual(racedBefore)
    expect(await fenceOf(excluded)).toEqual(circle(lat, lng))
    expect(await fenceOf(deleted)).toEqual(circle(lat, lng))

    const rollback = JSON.parse(readFileSync(rollbackPath, "utf8")) as RollbackFile
    expect(rollback.release).toBe("2026-11-18.0")
    expect(rollback.rows.find((r) => r.id === inScope)).toEqual({ id: inScope, previous: circle(lat, lng), written: building })
    expect(rollback.rows.find((r) => r.id === bare)).toEqual({ id: bare, previous: null, written: building })
  })

  it("changes nothing the second time", async () => {
    const again = await applyFences(db, file(rows), { write: true, exclude: new Set([excluded]), rollbackPath: join(dir, "again.json") })
    expect(again).toEqual([])
  })

  it("reverts exactly what it wrote, and leaves a venue edited since", async () => {
    const edited = polygonOf(0.0002)
    await db.venues.update({ where: { id: bare }, data: { geofence: edited } })
    const rollback = JSON.parse(readFileSync(rollbackPath, "utf8")) as RollbackFile

    expect(await revertFences(db, rollback, { write: false })).toEqual([inScope])
    expect(await fenceOf(inScope)).toEqual(building)

    expect(await revertFences(db, rollback, { write: true })).toEqual([inScope])
    expect(await fenceOf(inScope)).toEqual(circle(lat, lng))
    expect(await fenceOf(bare)).toEqual(edited)
    expect(await revertFences(db, rollback, { write: true })).toEqual([])
  })

  it("puts a fence-less venue back to no fence at all", async () => {
    const id = await venue("bare-revert", { geofence: undefined })
    const path = join(dir, "bare.json")
    await applyFences(db, file([await rowFor(id)]), { write: true, exclude: new Set(), rollbackPath: path })
    expect(await fenceOf(id)).toEqual(building)
    await revertFences(db, JSON.parse(readFileSync(path, "utf8")) as RollbackFile, { write: true })
    expect(await fenceOf(id)).toBeNull()
  })
})

describe("the pilot venue", () => {
  beforeAll(async () => {
    await db.venues.deleteMany({ where: { id: PILOT_VENUE_ID } })
    await db.venues.create({ data: { id: PILOT_VENUE_ID, name: testId("pilot"), source: "overture:x", geofence: circle(lat, lng) } })
    venues.push(PILOT_VENUE_ID)
  })

  it("an apply refuses a database holding it unless it is excluded", async () => {
    const rows = [await rowFor(PILOT_VENUE_ID)]
    const path = join(dir, "pilot.json")
    await expect(applyFences(db, file(rows), { write: true, exclude: new Set(), rollbackPath: path })).rejects.toThrow(
      /--exclude 0fbaa05a-2d36-45fc-8066-82742636044c/
    )
    expect(await fenceOf(PILOT_VENUE_ID)).toEqual(circle(lat, lng))

    const done = await applyFences(db, file(rows), { write: true, exclude: new Set([PILOT_VENUE_ID]), rollbackPath: path })
    expect(done).toEqual([])
    expect(await fenceOf(PILOT_VENUE_ID)).toEqual(circle(lat, lng))
  })
})
