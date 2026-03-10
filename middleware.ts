import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { getToken } from "next-auth/jwt"

const ALLOWED_ORIGINS = [
  "https://api.blendn.app",
  "https://blendn.app",
  process.env.NEXTAUTH_URL,
].filter(Boolean) as string[]

function getCorsHeaders(origin: string | null) {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const origin = req.headers.get("origin")

  // API versioning: rewrite /api/mobile/v1/* to /api/mobile/*
  if (pathname.startsWith("/api/mobile/v1/") || pathname === "/api/mobile/v1") {
    const rewritten = pathname.replace("/api/mobile/v1", "/api/mobile")
    const url = req.nextUrl.clone()
    url.pathname = rewritten
    const response = NextResponse.rewrite(url)
    response.headers.set("X-API-Version", "v1")
    const corsHeaders = getCorsHeaders(origin)
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value)
    })
    return response
  }

  // Handle CORS for mobile API routes
  if (pathname.startsWith("/api/mobile")) {
    const corsHeaders = getCorsHeaders(origin)

    // Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 200,
        headers: corsHeaders,
      })
    }

    // Add CORS headers to actual requests
    const response = NextResponse.next()
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value)
    })
    return response
  }

  // Handle dashboard auth
  const token = await getToken({ req })

  // Redirect authenticated users away from landing and login pages
  if (pathname === "/" || pathname === "/login") {
    if (token && token.role !== "attendee") {
      return NextResponse.redirect(new URL("/dashboard", req.url))
    }
  }

  if (pathname.startsWith("/dashboard")) {
    if (!token) {
      const redirectUrl = req.nextUrl.clone()
      redirectUrl.pathname = "/login"
      return NextResponse.redirect(redirectUrl)
    }
    if (token.role === "attendee") {
      const redirectUrl = req.nextUrl.clone()
      redirectUrl.pathname = "/login"
      return NextResponse.redirect(redirectUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/", "/dashboard/:path*", "/api/mobile/:path*", "/login"],
  // Note: /api/mobile/v1/* is matched by /api/mobile/:path*
}
