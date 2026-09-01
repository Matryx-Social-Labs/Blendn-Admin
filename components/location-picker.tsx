"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import type { Map as LeafletMap, Marker, Circle, LeafletMouseEvent } from "leaflet"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { IconMapPin, IconSearch } from "@tabler/icons-react"
import { extractAddress } from "@/lib/address"

/**
 * `null` rather than `""` for the parts the geocoder could not name.
 *
 * An empty string is a value: it groups, it sorts, and it compares equal to
 * other empty strings, so a set of events "in ''" looks like a real cohort to
 * anything counting cities. `null` is the honest answer and the one the column
 * already allows (`city` and friends are `nullish` in `lib/validations/event.ts`).
 */
export interface LocationData {
  lat: number
  lng: number
  address: string
  city: string | null
  state: string | null
  country: string | null
  postal_code: string | null
}

interface NominatimResult {
  place_id: number
  lat: string
  lon: string
  display_name: string
  address: {
    city?: string
    town?: string
    village?: string
    municipality?: string
    state?: string
    region?: string
    country?: string
    postcode?: string
    road?: string
    house_number?: string
  }
}

interface LocationPickerProps {
  initialLat?: number
  initialLng?: number
  checkInRadius?: number
  onLocationChange: (data: LocationData) => void
}

export function LocationPicker({
  initialLat,
  initialLng,
  checkInRadius = 100,
  onLocationChange,
}: LocationPickerProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const circleRef = useRef<Circle | null>(null)
  const checkInRadiusRef = useRef(checkInRadius)
  /**
   * The live `addMarkerAndCircle`, and the coordinates it should be showing.
   *
   * The map is built inside a `[]` effect and its helpers close over Leaflet,
   * so nothing outside could move the pin. These two are what let a later prop
   * change reach it, following the same ref-plus-effect shape
   * `checkInRadiusRef` already uses for the circle's radius.
   *
   * `desiredRef` exists because Leaflet is imported asynchronously: a venue
   * picked before `import("leaflet")` resolves would otherwise be lost, since
   * the init effect's closure holds the props from mount.
   */
  const placeRef = useRef<((lat: number, lng: number) => void) | null>(null)
  const desiredRef = useRef<{ lat: number; lng: number } | null>(
    initialLat != null && initialLng != null ? { lat: initialLat, lng: initialLng } : null
  )

  const [search, setSearch] = useState("")
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  /**
   * Reading the response is `lib/address.ts`'s job, not this component's.
   *
   * The chain used to live here, and a second one lived in the venue form with
   * `village` and `municipality` missing — so a pin in a village came back as
   * the village from this screen and as the surrounding district from that one.
   */
  const extractLocationData = useCallback(
    (lat: number, lng: number, data?: NominatimResult): LocationData => {
      const resolved = extractAddress(lat, lng, data)
      return {
        lat,
        lng,
        address: resolved.address,
        city: resolved.city,
        state: resolved.state,
        country: resolved.country,
        postal_code: resolved.postalCode,
      }
    },
    []
  )

  const reverseGeocode = useCallback(
    async (lat: number, lng: number) => {
      try {
        const res = await fetch(
          `/api/geocode?lat=${lat}&lon=${lng}`,
          { headers: { "Accept-Language": "en" } }
        )
        const data: NominatimResult = await res.json()
        onLocationChange(extractLocationData(lat, lng, data))
      } catch {
        onLocationChange(extractLocationData(lat, lng))
      }
    },
    [onLocationChange, extractLocationData]
  )

  useEffect(() => {
    checkInRadiusRef.current = checkInRadius
    circleRef.current?.setRadius(checkInRadius)
  }, [checkInRadius])

  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return

    // Load Leaflet CSS from CDN
    if (!document.querySelector('link[data-leaflet]')) {
      const link = document.createElement("link")
      link.rel = "stylesheet"
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      link.dataset.leaflet = "true"
      document.head.appendChild(link)
    }

    /*
     * From the ref, not the closure: a venue picked while Leaflet was still
     * loading has already updated `desiredRef`, and the props captured at mount
     * would put the pin back where it started.
     */
    const desired = desiredRef.current
    const defaultLat = desired?.lat ?? 12.9716
    const defaultLng = desired?.lng ?? 77.5946
    // `!= null`, because `Boolean(lat && lng)` is false on the equator and the
    // prime meridian — the same bug `canPublish` documents having replaced.
    const hasInitialLocation = desired != null

    import("leaflet").then((L) => {
      if (!mapContainerRef.current || mapInstanceRef.current) return

      // Fix default marker icons
      delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:
          "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      })

      const map = L.map(mapContainerRef.current!).setView(
        [defaultLat, defaultLng],
        hasInitialLocation ? 14 : 12
      )
      mapInstanceRef.current = map

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)

      const addMarkerAndCircle = (lat: number, lng: number) => {
        const latlng = L.latLng(lat, lng)
        if (markerRef.current) {
          markerRef.current.setLatLng(latlng)
        } else {
          const marker = L.marker(latlng, { draggable: true }).addTo(map)
          markerRef.current = marker
          marker.on("dragend", async () => {
            const pos = marker.getLatLng()
            circleRef.current?.setLatLng(pos)
            await reverseGeocode(pos.lat, pos.lng)
          })
        }
        if (circleRef.current) {
          circleRef.current.setLatLng(latlng)
        } else {
          const circle = L.circle(latlng, {
            radius: checkInRadiusRef.current,
            color: "#6366f1",
            fillColor: "#6366f1",
            fillOpacity: 0.15,
            weight: 2,
          }).addTo(map)
          circleRef.current = circle
        }
      }

      placeRef.current = addMarkerAndCircle

      if (hasInitialLocation) {
        addMarkerAndCircle(defaultLat, defaultLng)
      }

      map.on("click", async (e: LeafletMouseEvent) => {
        const { lat, lng } = e.latlng
        addMarkerAndCircle(lat, lng)
        await reverseGeocode(lat, lng)
      })
    })

    return () => {
      mapInstanceRef.current?.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      circleRef.current = null
      placeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * Follow the coordinates when something else moves them.
   *
   * Picking a venue writes `latitude`/`longitude` on the form and the parent
   * passes them down. Without this the pin stayed where it was while the fence
   * and the read-only coordinates moved — two maps on one screen disagreeing
   * about where the event is, which is the diagnosis of this whole audit
   * rendered side by side.
   *
   * **This effect is the fix.** The map is built in a `[]` effect, so a new
   * prop reached the component and could do nothing with it. The parent's
   * `getValues` looked like the other half and was not: a control reverting it
   * left the browser test passing, because a sibling `watch` re-renders the
   * section at the same moment.
   *
   * The distance guard is what stops it fighting the user: dragging the marker
   * calls `onLocationChange`, the parent writes those values back, and they
   * arrive here as new props. Without the comparison that would re-place the
   * marker on every drag and pan the map out from under them.
   */
  useEffect(() => {
    if (initialLat == null || initialLng == null) return
    desiredRef.current = { lat: initialLat, lng: initialLng }

    const current = markerRef.current?.getLatLng()
    if (
      current &&
      Math.abs(current.lat - initialLat) < 1e-7 &&
      Math.abs(current.lng - initialLng) < 1e-7
    ) {
      return
    }

    // Null until Leaflet resolves. `desiredRef` above is what the init effect
    // reads, so nothing is lost by returning here.
    placeRef.current?.(initialLat, initialLng)
    mapInstanceRef.current?.setView([initialLat, initialLng], 15)
  }, [initialLat, initialLng])

  const handleSearch = useCallback((query: string) => {
    setSearch(query)
    clearTimeout(searchTimeoutRef.current)
    if (!query.trim()) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true)
      try {
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(query)}`,
          { headers: { "Accept-Language": "en" } }
        )
        const data: NominatimResult[] = await res.json()
        setSuggestions(data)
        setShowSuggestions(true)
      } catch {
        setSuggestions([])
      } finally {
        setIsSearching(false)
      }
    }, 500)
  }, [])

  const selectSuggestion = useCallback(
    (result: NominatimResult) => {
      const lat = parseFloat(result.lat)
      const lng = parseFloat(result.lon)
      setSearch(result.display_name)
      setSuggestions([])
      setShowSuggestions(false)

      import("leaflet").then((L) => {
        if (!mapInstanceRef.current) return
        const latlng = L.latLng(lat, lng)
        mapInstanceRef.current.setView(latlng, 15)

        if (markerRef.current) {
          markerRef.current.setLatLng(latlng)
        } else {
          const marker = L.marker(latlng, { draggable: true }).addTo(
            mapInstanceRef.current
          )
          markerRef.current = marker
          marker.on("dragend", async () => {
            const pos = marker.getLatLng()
            circleRef.current?.setLatLng(pos)
            await reverseGeocode(pos.lat, pos.lng)
          })
        }

        if (circleRef.current) {
          circleRef.current.setLatLng(latlng)
        } else {
          const circle = L.circle(latlng, {
            radius: checkInRadiusRef.current,
            color: "#6366f1",
            fillColor: "#6366f1",
            fillOpacity: 0.15,
            weight: 2,
          }).addTo(mapInstanceRef.current)
          circleRef.current = circle
        }
      })

      onLocationChange(extractLocationData(lat, lng, result))
    },
    [onLocationChange, extractLocationData, reverseGeocode]
  )

  return (
    <div className="space-y-2">
      <Popover open={showSuggestions} onOpenChange={setShowSuggestions}>
        <PopoverTrigger asChild>
          <div className="relative">
            <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search for a location..."
              className="pl-9 pr-20"
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            />
            {isSearching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                Searching…
              </span>
            )}
          </div>
        </PopoverTrigger>
        {suggestions.length > 0 && (
          <PopoverContent
            align="start"
            onOpenAutoFocus={(e) => e.preventDefault()}
            className="w-[var(--radix-popover-trigger-width)] p-0 max-h-60 overflow-y-auto"
          >
            {suggestions.map((result) => (
              <Button
                key={result.place_id}
                type="button"
                variant="ghost"
                className="w-full justify-start text-left px-3 py-2 h-auto text-sm hover:bg-muted flex items-start gap-2 font-normal"
                onClick={() => selectSuggestion(result)}
              >
                <IconMapPin className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                <span className="line-clamp-2">{result.display_name}</span>
              </Button>
            ))}
          </PopoverContent>
        )}
      </Popover>
      <div
        ref={mapContainerRef}
        className="h-72 w-full rounded-md border overflow-hidden"
        style={{ zIndex: 0 }}
      />
      <p className="text-xs text-muted-foreground">
        Search or click the map to set the location. Drag the pin to fine-tune.
        The purple circle shows the check-in radius.
      </p>
    </div>
  )
}
