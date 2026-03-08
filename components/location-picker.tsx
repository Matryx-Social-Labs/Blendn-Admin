"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { IconMapPin, IconSearch } from "@tabler/icons-react"

export interface LocationData {
  lat: number
  lng: number
  address: string
  city: string
  state: string
  country: string
  postal_code: string
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
  const mapInstanceRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const circleRef = useRef<any>(null)
  const checkInRadiusRef = useRef(checkInRadius)

  const [search, setSearch] = useState("")
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const extractLocationData = useCallback(
    (lat: number, lng: number, data?: NominatimResult): LocationData => {
      const addr = data?.address || {}
      return {
        lat,
        lng,
        address: data?.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        city: addr.city || addr.town || addr.village || addr.municipality || "",
        state: addr.state || addr.region || "",
        country: addr.country || "",
        postal_code: addr.postcode || "",
      }
    },
    []
  )

  const reverseGeocode = useCallback(
    async (lat: number, lng: number) => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
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

    const defaultLat = initialLat ?? 40.7128
    const defaultLng = initialLng ?? -74.006
    const hasInitialLocation = Boolean(initialLat && initialLng)

    import("leaflet").then((L) => {
      if (!mapContainerRef.current || mapInstanceRef.current) return

      // Fix default marker icons
      delete (L.Icon.Default.prototype as any)._getIconUrl
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
        hasInitialLocation ? 14 : 2
      )
      mapInstanceRef.current = map

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)

      const addMarkerAndCircle = (lat: number, lng: number, L: any) => {
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

      if (hasInitialLocation) {
        addMarkerAndCircle(defaultLat, defaultLng, L)
      }

      map.on("click", async (e: any) => {
        const { lat, lng } = e.latlng
        addMarkerAndCircle(lat, lng, L)
        await reverseGeocode(lat, lng)
      })
    })

    return () => {
      mapInstanceRef.current?.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      circleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`,
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
      <div className="relative">
        <div className="relative">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search for a location..."
            className="pl-9 pr-20"
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          />
          {isSearching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              Searching…
            </span>
          )}
        </div>
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border bg-background shadow-md max-h-60 overflow-y-auto">
            {suggestions.map((result) => (
              <button
                key={result.place_id}
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-start gap-2"
                onMouseDown={() => selectSuggestion(result)}
              >
                <IconMapPin className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                <span className="line-clamp-2">{result.display_name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
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
