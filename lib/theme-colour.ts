/**
 * A design token, as a colour string something outside CSS can use.
 *
 * Leaflet takes colours as JS strings on its layer options, so the two map
 * components could not reach for a Tailwind class and hardcoded hexes instead —
 * `#F05423`, `#BE5C71`, `#8F49AA` in the geofence editor, and `#6366f1`, an
 * indigo that is not in the brand palette at all, in the location picker.
 *
 * Duplication is the smaller half of the problem. `globals.css` defines the
 * chart hues **twice**, and the dark values are deliberately lifted — the
 * design system says the brand purple at its true lightness "does not carry
 * against `#0D0C0C`". The app is dark-pinned, so every copied literal was the
 * light-theme value, drawn on the dark theme.
 *
 * Reading the computed property keeps one definition and picks up whichever
 * theme is live. The fallback matters for SSR and for tests, where there is no
 * document to compute against.
 */
export function themeColour(token: string, fallback: string): string {
  if (typeof window === "undefined") return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return value || fallback
}
