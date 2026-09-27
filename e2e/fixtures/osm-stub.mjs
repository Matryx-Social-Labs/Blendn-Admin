/**
 * Recorded OpenStreetMap answers for CI's e2e (SCRUM-357).
 *
 * The server's /api/geocode and /api/footprint call Nominatim and Overpass.
 * An e2e run must not: they are flaky (Overpass answered 504 after 8.7 s on
 * 2026-09-27) and against their usage policies at volume. CI starts this and
 * points GEOCODE_UPSTREAM / FOOTPRINT_UPSTREAM at it.
 *
 * `osm/search-chinnaswamy.json` is one real Nominatim answer, recorded with
 * the product's User-Agent (data © OpenStreetMap contributors, ODbL).
 */
import { createServer } from "node:http"
import { readFileSync } from "node:fs"

const chinnaswamy = readFileSync(new URL("./osm/search-chinnaswamy.json", import.meta.url))
const port = Number(process.env.OSM_STUB_PORT ?? 4599)

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub")
  if (url.pathname === "/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase()
    return send(res, 200, q.includes("chinnaswamy") ? chinnaswamy : "[]")
  }
  if (url.pathname === "/reverse") {
    return send(res, 200, JSON.stringify({
      display_name: "Queen's Road, Shanthala Nagar, Bengaluru, Karnataka, 560001, India",
      address: { road: "Queen's Road", suburb: "Shanthala Nagar", city: "Bengaluru", state: "Karnataka", postcode: "560001", country: "India" },
    }))
  }
  if (url.pathname === "/api/interpreter") return send(res, 200, JSON.stringify({ version: 0.6, elements: [] }))
  send(res, 404, "{}")
}).listen(port, "127.0.0.1", () => console.log(`osm stub listening on ${port}`))
