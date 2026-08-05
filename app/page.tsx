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
    title: "Platform Reporting",
    description:
      "Track user activity, event supply, attendance, and demand signals in one reporting layer.",
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
      "Surface venue attendance, fill rate, demand, and event mix so owners can see what is working.",
  },
]

const pilotMetrics = [
  { label: "Platform Pulse", value: "Live demand, attendance, and operator activity" },
  { label: "Export Ready", value: "CSV downloads for platform, organiser, and venue reporting" },
  { label: "Role Based", value: "Separate views for admin, organisers, and venue owners" },
]

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden px-6 py-6 md:px-10">
      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-7xl flex-col rounded-xl border border-border bg-card">
        <header className="flex flex-col gap-5 border-b border-border px-6 py-6 md:flex-row md:items-center md:justify-between md:px-8">
          <BrandLogo size="hero" />
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary" className="rounded-full px-3 py-1 font-medium">
              Role-based reporting
            </Badge>
            <Button asChild variant="outline" className="rounded-full px-5">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </header>

        <section className="grid flex-1 gap-10 px-6 py-10 md:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div className="space-y-8">
            <div className="space-y-5">
              <Badge variant="secondary" className="rounded-full px-3 py-1 font-medium">
                Blend&apos;n operator cockpit
              </Badge>
              <div className="space-y-4">
                <h1 className="max-w-3xl text-4xl font-semibold leading-tight text-foreground sm:text-5xl lg:text-6xl">
                  A sharper control room for events, venues, and audience activity.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                  Blend&apos;n brings platform reporting, organiser operations, and venue
                  performance into one workspace so every team can manage what is live and review
                  what is working.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="rounded-full px-6">
                <Link href="/login">
                  Enter Dashboard
                  <IconArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full px-6">
                <Link href="/dashboard">Preview Shell</Link>
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {pilotMetrics.map((metric) => (
                <Card key={metric.label} className="rounded-xl shadow-none">
                  <CardContent className="space-y-2 px-5 py-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      {metric.label}
                    </p>
                    <p className="text-sm leading-6 text-foreground">{metric.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <div className="grid gap-4">
            <Card className="rounded-xl shadow-none">
              <CardContent className="space-y-6 px-6 py-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                      What changes here
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold text-foreground">
                      A dashboard built for live operations and clear reporting.
                    </h2>
                  </div>
                  <div className="rounded-full border border-border bg-muted p-3">
                    <IconUsers className="size-6 text-primary" />
                  </div>
                </div>
                <div className="grid gap-3">
                  {highlightCards.map((item) => (
                    <div
                      key={item.title}
                      className="flex gap-4 rounded-xl border border-border bg-muted/40 p-4"
                    >
                      <div className="mt-1 rounded-full bg-muted p-2">
                        <item.icon className="size-5 text-primary" />
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold text-foreground">{item.title}</h3>
                        <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
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
