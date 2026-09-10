import type { Metadata } from "next"

import { Providers } from "@/components/providers"
import { Toaster } from "@/components/ui/sonner"

import { satoshi } from "./fonts"
import "./globals.css"

export const metadata: Metadata = {
  title: {
    default: "Blend'n Admin",
    template: "%s | Blend'n Admin",
  },
  description:
    "Blend'n control center for investor reporting, organiser performance, and venue insights.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`dark ${satoshi.variable}`}>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
        {/*
          Mounted here because sonner renders nothing without it, and 44 files
          call `toast.*` — 148 sites, 79 of them errors. Every one was being
          discarded: approving an application, declining one, retiring a venue,
          removing a member, a refused domain claim. The guard would fire, the
          product would say nothing, and the button read as broken.

          `theme` is pinned rather than left to the wrapper's `useTheme()`.
          There is no ThemeProvider, so that hook falls back to "system" and
          would render a light toast on a dashboard whose <html> is hardcoded
          `dark`.
        */}
        <Toaster theme="dark" richColors />
      </body>
    </html>
  )
}
