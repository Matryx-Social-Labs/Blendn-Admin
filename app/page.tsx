import Link from "next/link"
import {
  IconArrowRight,
  IconBuildingStore,
  IconChartHistogram,
  IconMicrophone2,
  IconUsers,
} from "@tabler/icons-react"

import { BrandLogo } from "@/components/brand-logo"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

const highlightCards = [
  {
    icon: IconChartHistogram,
    title: "Investor Reporting",
    description:
      "Track activation, retention proxies, host velocity, attendance, and demand signals in one view.",
  },
  {
    icon: IconMicrophone2,
    title: "Organiser Insights",
    description:
      "Measure portfolio health across events, chat activity, interest conversion, ratings, and repeat attendance.",
  },
  {
    icon: IconBuildingStore,
    title: "Venue Performance",
    description:
      "Surface venue-level attendance, fill rate, demand, and event mix so owners understand what is working.",
  },
]

const pilotMetrics = [
  { label: "Platform Pulse", value: "Live demand, activity, and host momentum" },
  { label: "Export Ready", value: "Investor snapshots and operator CSV downloads" },
  { label: "Role Based", value: "Separate views for admin, organisers, and venue owners" },
]

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden px-6 py-6 md:px-10">
      <div className="brand-mesh pointer-events-none absolute inset-0 opacity-80" />

      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-7xl flex-col rounded-[2rem] border border-white/10 brand-surface">
        <header className="flex flex-col gap-5 border-b border-white/10 px-6 py-6 md:flex-row md:items-center md:justify-between md:px-8">
          <BrandLogo showTagline />
          <div className="flex flex-wrap items-center gap-3">
            <Badge className="brand-chip rounded-full px-3 py-1 font-medium">
              MVP investor narrative
            </Badge>
            <Button
              asChild
              variant="outline"
              className="rounded-full border-white/15 bg-white/5 px-5 text-white hover:bg-white/10"
            >
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </header>

        <section className="grid flex-1 gap-10 px-6 py-10 md:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div className="space-y-8">
            <div className="space-y-5">
              <Badge className="brand-chip rounded-full px-3 py-1 font-medium">
                Blend&apos;n operator cockpit
              </Badge>
              <div className="space-y-4">
                <h1 className="max-w-3xl text-4xl font-semibold leading-tight text-white sm:text-5xl lg:text-6xl">
                  A sharper control room for growth, attendance, and host performance.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-white/68 sm:text-lg">
                  The admin surface now frames Blend&apos;n as a live marketplace: investor-level
                  traction signals for the platform, operational analytics for organisers, and
                  venue intelligence that turns events into measurable performance.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                asChild
                size="lg"
                className="rounded-full bg-[#F05423] px-6 text-white hover:bg-[#d84a1d]"
              >
                <Link href="/login">
                  Enter Dashboard
                  <IconArrowRight className="size-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="rounded-full border-white/15 bg-transparent px-6 text-white hover:bg-white/8"
              >
                <Link href="/dashboard">Preview Shell</Link>
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {pilotMetrics.map((metric) => (
                <Card
                  key={metric.label}
                  className="rounded-[1.4rem] border-white/10 bg-white/[0.04] text-white shadow-none"
                >
                  <CardContent className="space-y-2 px-5 py-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/48">
                      {metric.label}
                    </p>
                    <p className="text-sm leading-6 text-white/78">{metric.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div className="grid gap-4">
            <Card className="rounded-[1.8rem] border-white/10 bg-black/30 text-white shadow-none">
              <CardContent className="space-y-6 px-6 py-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/48">
                      What changes here
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold brand-gradient-text">
                      A dashboard built for proof, not placeholders.
                    </h2>
                  </div>
                  <div className="rounded-full border border-white/12 bg-white/6 p-3">
                    <IconUsers className="size-6 text-[#F05423]" />
                  </div>
                </div>
                <div className="grid gap-3">
                  {highlightCards.map((item) => (
                    <div
                      key={item.title}
                      className="flex gap-4 rounded-[1.4rem] border border-white/8 bg-white/[0.04] p-4"
                    >
                      <div className="mt-1 rounded-full bg-white/8 p-2">
                        <item.icon className="size-5 text-[#F05423]" />
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold text-white">{item.title}</h3>
                        <p className="text-sm leading-6 text-white/68">{item.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </main>
  )
}
