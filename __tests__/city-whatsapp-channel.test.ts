import { citiesResponse } from "@/lib/browse-scope"
import { buildCatalogue, type CityRow, type MarketRow } from "@/lib/cities"

/*
 * Flow 9 A, ruling 7: Notification settings' "Your city" row opens the city's WhatsApp Channel. The URL is city data
 * (`cities.whatsapp_channel_url`, CHECKed to an https whatsapp.com/channel/ link), sent on each city of
 * `GET /events/cities`: null for a city without one, and for any city the catalogue does not know.
 */
const market = (code: string): MarketRow => ({ code, name: code, launch_state: "live", sort: 0 })
const city = (over: Partial<CityRow> & Pick<CityRow, "slug" | "name" | "market_code">): CityRow => ({
  id: `id-${over.slug}`,
  match_names: [],
  timezone: "UTC",
  launch_state: "live",
  is_default: false,
  centre_lat: 0,
  centre_lon: 0,
  min_lat: -1,
  min_lon: -1,
  max_lat: 1,
  max_lon: 1,
  sort: 0,
  ...over,
})

const CHANNEL = "https://whatsapp.com/channel/0029VaBlendnBLR01"

it("sends each city's channel, null where it has none or is not catalogued", () => {
  const catalogue = buildCatalogue(
    [market("IN"), market("CA")],
    [
      city({ slug: "bengaluru", name: "Bengaluru", market_code: "IN", whatsapp_channel_url: CHANNEL }),
      city({ slug: "toronto", name: "Toronto", market_code: "CA" }),
    ]
  )
  const at = (name: string) => ({ city: name, latitude: null, longitude: null })
  const res = citiesResponse({
    catalogue,
    events: [at("Bengaluru"), at("Toronto"), at("Thiruvananthapuram Downtown")],
    places: [],
    previewMarkets: new Set(),
    wantsPreview: false,
    deviceCountry: null,
  })
  const byName = new Map(res.cities.map((c) => [c.city, c.whatsappChannelUrl]))
  expect(byName.get("Bengaluru")).toBe(CHANNEL)
  expect(byName.get("Toronto")).toBeNull()
  expect(byName.get("Thiruvananthapuram Downtown")).toBeNull()
})
