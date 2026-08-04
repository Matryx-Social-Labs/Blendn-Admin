"use client"

import * as Sentry from "@sentry/nextjs"
import { useEffect } from "react"

/**
 * Last-resort boundary for errors thrown while React renders the root layout.
 *
 * Next.js does not route those through the normal error boundary, so without
 * this file they never reach Sentry — the build warned about exactly that on
 * every run. A render crash here is the case where the user sees a blank page
 * and we would otherwise have no report explaining why.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#666", fontSize: "0.875rem", lineHeight: 1.6 }}>
            The page failed to load. This has been reported. Try reloading, and
            if it keeps happening let us know.
          </p>
          {/* The digest is what ties a user report to the Sentry event. */}
          {error.digest && (
            <p style={{ color: "#999", fontSize: "0.75rem", marginTop: "1rem" }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: "1.5rem",
              padding: "0.5rem 1.25rem",
              borderRadius: "9999px",
              border: "1px solid #ddd",
              background: "#fff",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
