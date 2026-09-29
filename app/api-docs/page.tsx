"use client"

import { useEffect, useRef, useState } from "react"

import "swagger-ui-dist/swagger-ui.css"
import "./swagger-dark.css"

/**
 * The API reference — admin-only, and loaded only when one opens it.
 *
 * ## Swagger UI prebuilt, not bundled (SCRUM-463)
 *
 * `swagger-ui-react` handed its module graph to our bundler, and Turbopack
 * dropped the modules that exist for their side effects: apidom attaches
 * `refract` to each OpenAPI 3.1 element class in `refractor/registration.mjs`,
 * which the package lists in `sideEffects` and Turbopack skipped anyway while
 * following its re-exports. `/api-docs` threw `oS.refract is not a function` and
 * drew 2 of 22 sections. Turning off every tree-shaking flag Next exposes did
 * not bring the module back, measured in a local production build.
 *
 * `swagger-ui-dist` ships Swagger UI already built, one file with nothing left
 * for a bundler to shake, so the registrations run.
 *
 * ## Why it is gated and lazy
 *
 * **It was public.** `middleware.ts` requires `app_admin` here and answers
 * `/api/docs` with a 404 rather than a 401: the map of the mobile API is the
 * reconnaissance step that makes finding a vulnerability cheap.
 *
 * **It carries a flagged parser.** The bundle includes `js-yaml`, whose
 * high-severity advisory (quadratic CPU on `!!omap`) has no fixed release. So
 * the bundle is fetched only when an admin opens this page, never evaluated
 * during SSR, and only ever parses `/api/docs`, our own JSON on this origin.
 *
 * If the viewer goes, `/api/docs` still serves the spec to any local viewer.
 */
export default function ApiDocsPage() {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading")

  useEffect(() => {
    let cancelled = false
    import("swagger-ui-dist/swagger-ui-bundle.js")
      .then(({ default: SwaggerUIBundle }) => {
        if (cancelled || !host.current) return
        SwaggerUIBundle({ domNode: host.current, url: "/api/docs" })
        setState("ready")
      })
      .catch(() => setState("failed"))
    return () => {
      cancelled = true
    }
  }, [])

  // Swagger UI renders its own React tree into `host`, so nothing of ours goes inside it.
  return (
    <div className="swagger-container">
      {state !== "ready" && (
        <p className="p-8 text-sm text-muted-foreground">
          {state === "failed" ? "The API reference didn't load. The spec is at /api/docs." : "Loading the API reference…"}
        </p>
      )}
      <div ref={host} />
    </div>
  )
}
