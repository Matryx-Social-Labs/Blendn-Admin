"use client"

import dynamic from "next/dynamic"

/*
 * The base stylesheet stays a static import while the component is lazy.
 *
 * A CSS import is resolved by the bundler as a stylesheet, not as a module
 * graph edge — it does not pull `swagger-ui-react`'s JavaScript (and therefore
 * not `js-yaml`) into this chunk. Dropping it while lazy-loading the component
 * renders the reference completely unstyled, because `swagger-dark.css` is an
 * override and not a replacement.
 */
import "swagger-ui-react/swagger-ui.css"
import "./swagger-dark.css"

/**
 * The API reference — admin-only, and loaded only when one opens it.
 *
 * ## Two separate problems, two separate fixes
 *
 * **It was public.** This page and `/api/docs` had no check of any kind, so the
 * complete map of the mobile API — every endpoint, its parameters, and which of
 * them need a token — was readable by anyone who guessed the path. That is not
 * a vulnerability by itself; it is the reconnaissance step that makes finding
 * one cheap. `middleware.ts` now requires `app_admin`, and answers the JSON
 * route with a 404 rather than a 401, because telling an anonymous caller that
 * a spec exists here is half the disclosure.
 *
 * **It shipped a flagged parser.** `swagger-ui-react` is a production
 * dependency and pulls in `js-yaml`, which carries a high-severity advisory
 * (quadratic CPU on `!!omap`) whose fix was **not backported** — 4.3.1 is both
 * the latest release and the affected one, so pinning buys nothing and there is
 * no version to upgrade to.
 *
 * What is left is blast radius, so that is what changed. `next/dynamic` with
 * `ssr: false` puts Swagger UI in its own chunk, fetched only when an admin
 * opens this page. It is no longer in any other route's bundle, is never
 * evaluated during SSR, and is unreachable without an admin session.
 *
 * The residual risk is narrow, and worth stating rather than implying away: the
 * parser only ever reads `/api/docs`, our own generated JSON on the same
 * origin. An attacker cannot point it at hostile YAML without already
 * controlling the spec route.
 *
 * If `swagger-ui-react` is dropped later, `/api/docs` still serves the spec and
 * any local viewer renders it — the endpoint is the durable half, the UI is the
 * convenience.
 */
const SwaggerUI = dynamic(() => import("swagger-ui-react"), {
  ssr: false,
  loading: () => <p className="p-8 text-sm text-muted-foreground">Loading the API reference…</p>,
})

export default function ApiDocsPage() {
  return (
    <div className="swagger-container">
      <SwaggerUI url="/api/docs" />
    </div>
  )
}
