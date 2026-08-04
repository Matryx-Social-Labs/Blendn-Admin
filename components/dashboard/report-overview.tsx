"use client"

import { useMemo, useState } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconMinus,
  IconSearch,
} from "@tabler/icons-react"

import { ExportMenu } from "@/components/dashboard/export-menu"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type {
  DashboardMetric,
  DashboardReport,
  DashboardTrendKey,
} from "@/lib/dashboard-types"
import { cn } from "@/lib/utils"

const trendKeyStyles: Record<DashboardTrendKey, { color: string }> = {
  users: { color: "var(--chart-1)" },
  events: { color: "var(--chart-2)" },
  attendees: { color: "var(--chart-3)" },
  engagement: { color: "var(--chart-4)" },
}

function trendLabel(key: DashboardTrendKey, role: DashboardReport["role"]) {
  switch (key) {
    case "users":
      return role === "app_admin" ? "Users" : "Audience"
    case "events":
      return "Events"
    case "attendees":
      return "Attendance"
    case "engagement":
      return "Engagement"
  }
}

function metricIcon(trend: DashboardMetric["trend"]) {
  if (trend === "up") {
    return <IconArrowUpRight className="size-4 text-chart-1" />
  }

  if (trend === "down") {
    return <IconArrowDownRight className="size-4 text-destructive" />
  }

  return <IconMinus className="size-4 text-muted-foreground" />
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ")
}

function formatDate(dateValue: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(dateValue))
}

function formatNumericValue(value: number | null) {
  if (value === null) {
    return "—"
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value)
}

export function ReportOverview({ report }: { report: DashboardReport }) {
  const [activeTrend, setActiveTrend] = useState<DashboardTrendKey>(report.trend.defaultKey)
  const [windowSize, setWindowSize] = useState<"3m" | "6m">("6m")
  const [search, setSearch] = useState("")

  const trendPoints = useMemo(
    () => (windowSize === "3m" ? report.trend.points.slice(-3) : report.trend.points),
    [report.trend.points, windowSize]
  )

  const performanceRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) {
      return report.performance.rows
    }

    return report.performance.rows.filter((row) =>
      [row.name, row.segment, row.city, row.status].some((value) =>
        value.toLowerCase().includes(query)
      )
    )
  }, [report.performance.rows, search])

  const funnelMax = useMemo(
    () => Math.max(...report.funnel.stages.map((stage) => stage.value), 1),
    [report.funnel.stages]
  )

  return (
    <div className="flex flex-col gap-6 py-6">
      <section className="px-4 lg:px-6">
        <Card className="rounded-xl">
          <CardContent className="px-6 py-7 lg:px-8">
            <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
              <div className="max-w-3xl space-y-4">
                <Badge variant="secondary" className="rounded-full px-3 py-1 font-medium">
                  {report.role === "app_admin"
                    ? "Platform reporting"
                    : report.role === "organizer"
                      ? "Organiser reporting"
                      : "Venue reporting"}
                </Badge>
                <div className="space-y-3">
                  <h1 className="text-3xl font-semibold sm:text-4xl">
                    {report.headline}
                  </h1>
                  <p className="max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
                    {report.summary}
                  </p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:w-[430px]">
                {report.spotlights.slice(0, 2).map((card) => (
                  <Card key={card.title} className="rounded-lg bg-muted">
                    <CardContent className="p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {card.title}
                      </p>
                      <p className="mt-3 text-2xl font-semibold">{card.value}</p>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">{card.description}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        {report.metrics.map((metric) => (
          <Card key={metric.label} className="rounded-xl shadow-none">
            <CardContent className="space-y-4 px-5 py-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
                  <p className="mt-3 text-3xl font-semibold">{metric.value}</p>
                </div>
                <div className="rounded-full border border-border bg-accent p-2">
                  {metricIcon(metric.trend)}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">{metric.delta}</p>
                <p className="text-sm leading-6 text-muted-foreground">{metric.detail}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-6 px-4 lg:px-6 xl:grid-cols-[1.45fr_0.55fr]">
        <Card className="rounded-xl shadow-none">
          <CardHeader className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <CardTitle className="text-xl">{report.trend.title}</CardTitle>
              <p className="text-sm leading-6 text-muted-foreground">{report.trend.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(["users", "events", "attendees", "engagement"] as DashboardTrendKey[]).map((key) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setActiveTrend(key)}
                  className={cn(
                    "rounded-full border border-border px-3 text-muted-foreground hover:bg-accent hover:text-foreground",
                    activeTrend === key && "bg-accent text-foreground"
                  )}
                >
                  {trendLabel(key, report.role)}
                </Button>
              ))}
              <div className="ml-0 flex items-center gap-2 sm:ml-2">
                {(["3m", "6m"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setWindowSize(value)}
                    className={cn(
                      "rounded-full border border-border px-3 text-muted-foreground hover:bg-accent hover:text-foreground",
                      windowSize === value && "bg-accent text-foreground"
                    )}
                  >
                    {value.toUpperCase()}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 py-5 sm:px-6">
            <ChartContainer
              config={{
                [activeTrend]: {
                  label: trendLabel(activeTrend, report.role),
                  color: trendKeyStyles[activeTrend].color,
                },
              }}
              className="h-[320px] w-full"
            >
              <AreaChart data={trendPoints}>
                <defs>
                  <linearGradient id={`gradient-${activeTrend}`} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor={trendKeyStyles[activeTrend].color}
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="95%"
                      stopColor={trendKeyStyles[activeTrend].color}
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  tick={{ fill: "var(--muted-foreground)" }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  tick={{ fill: "var(--muted-foreground)" }}
                />
                <ChartTooltip
                  cursor={{ stroke: "var(--border)" }}
                  content={
                    <ChartTooltipContent
                      className="rounded-xl border-border bg-card text-foreground"
                      formatter={(value) => (
                        <span className="font-medium">{formatNumericValue(Number(value))}</span>
                      )}
                    />
                  }
                />
                <Area
                  type="monotone"
                  dataKey={activeTrend}
                  stroke={trendKeyStyles[activeTrend].color}
                  strokeWidth={2.5}
                  fill={`url(#gradient-${activeTrend})`}
                  dot={{
                    r: 3,
                    fill: trendKeyStyles[activeTrend].color,
                    stroke: trendKeyStyles[activeTrend].color,
                  }}
                  activeDot={{
                    r: 5,
                    fill: trendKeyStyles[activeTrend].color,
                    stroke: "var(--background)",
                  }}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-none">
          <CardHeader className="border-b pb-5">
            <CardTitle className="text-xl">{report.funnel.title}</CardTitle>
            <p className="text-sm leading-6 text-muted-foreground">{report.funnel.description}</p>
          </CardHeader>
          <CardContent className="space-y-4 px-5 py-5">
            {report.funnel.stages.map((stage, index) => (
              <div key={stage.label} className="space-y-2 rounded-lg border border-border bg-muted p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Stage {index + 1}
                    </p>
                    <h3 className="mt-1 text-base font-semibold">{stage.label}</h3>
                  </div>
                  <p className="text-2xl font-semibold">
                    {formatNumericValue(stage.value)}
                  </p>
                </div>
                <div className="h-2 rounded-full bg-border">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-chart-1 via-chart-2 to-chart-3"
                    style={{ width: `${Math.max(10, (stage.value / funnelMax) * 100)}%` }}
                  />
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{stage.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 px-4 lg:px-6 md:grid-cols-2 xl:grid-cols-4">
        {report.spotlights.map((card) => (
          <Card key={card.title} className="rounded-xl shadow-none">
            <CardContent className="space-y-3 px-5 py-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {card.title}
              </p>
              <p className="text-3xl font-semibold">{card.value}</p>
              <p className="text-sm leading-6 text-muted-foreground">{card.description}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="px-4 lg:px-6">
        <Card className="rounded-xl shadow-none">
          <CardHeader className="gap-4 border-b pb-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <CardTitle className="text-xl">{report.performance.title}</CardTitle>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {report.performance.description}
              </p>
            </div>
            <ExportMenu bundles={report.exports} />
          </CardHeader>
          <CardContent className="space-y-5 px-5 py-5">
            <div className="relative max-w-sm">
              <IconSearch className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search events, cities, categories, or status"
                className="h-12 rounded-xl pl-11"
              />
            </div>

            <Table className="min-w-[940px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-11 px-3 text-muted-foreground">Event</TableHead>
                  <TableHead className="h-11 px-3 text-muted-foreground">Segment</TableHead>
                  <TableHead className="h-11 px-3 text-muted-foreground">Status</TableHead>
                  <TableHead className="h-11 px-3 text-muted-foreground">City / Venue</TableHead>
                  <TableHead className="h-11 px-3 text-muted-foreground">Start</TableHead>
                  <TableHead className="h-11 px-3 text-right text-muted-foreground">Attendees</TableHead>
                  <TableHead className="h-11 px-3 text-right text-muted-foreground">Demand</TableHead>
                  <TableHead className="h-11 px-3 text-right text-muted-foreground">Engagement</TableHead>
                  <TableHead className="h-11 px-3 text-right text-muted-foreground">Rating</TableHead>
                  <TableHead className="h-11 px-3 text-right text-muted-foreground">Capacity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {performanceRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="px-3 py-4">
                      <div className="space-y-1">
                        <p className="font-medium">{row.name}</p>
                        <p className="text-xs text-muted-foreground">ID {row.id.slice(0, 8)}</p>
                      </div>
                    </TableCell>
                    <TableCell className="px-3 text-muted-foreground">{row.segment}</TableCell>
                    <TableCell className="px-3">
                      <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">
                        {formatStatus(row.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-3 text-muted-foreground">{row.city}</TableCell>
                    <TableCell className="px-3 text-muted-foreground">{formatDate(row.startAt)}</TableCell>
                    <TableCell className="px-3 text-right">{formatNumericValue(row.attendees)}</TableCell>
                    <TableCell className="px-3 text-right">{formatNumericValue(row.demand)}</TableCell>
                    <TableCell className="px-3 text-right">{formatNumericValue(row.engagement)}</TableCell>
                    <TableCell className="px-3 text-right">{formatNumericValue(row.rating)}</TableCell>
                    <TableCell className="px-3 text-right">{formatNumericValue(row.capacity)}</TableCell>
                  </TableRow>
                ))}
                {performanceRows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={10} className="px-3 py-10 text-center text-sm text-muted-foreground">
                      No events matched this filter.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
