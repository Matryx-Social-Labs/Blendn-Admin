import type { Metadata } from "next"

import { Providers } from "@/components/providers"

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
      </body>
    </html>
  )
}
