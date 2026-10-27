import type { Metadata } from "next"
import Link from "next/link"

import { PolicyPage } from "@/components/policy-page"
import { COMPANY } from "@/lib/company"

export const metadata: Metadata = { title: "About" }

export default function AboutPage() {
  return (
    <PolicyPage path="/about" title="About Blend'n" updated="26 October 2026">
      <p>
        Blend&apos;n is an app for meeting people at real events. Attendees check in at an event and join its room;
        hosts and venues run their nights from this dashboard. Blend&apos;n is built by {COMPANY.brand}, legally{" "}
        {COMPANY.legalName}, a company registered in India and based in Bengaluru.
      </p>

      <h2>What the dashboard is for</h2>
      <ul>
        <li>
          <strong>Hosts</strong> create and publish events, see who checks in, moderate the event&apos;s chat room
          and read each event&apos;s numbers.
        </li>
        <li>
          <strong>Venues</strong> claim their place, see who is in the building and operate the events held there.
        </li>
        <li>
          <strong>Sponsors</strong> buy placements in event rooms.
        </li>
      </ul>
      <p>
        Using the dashboard is free. Paid plans add deeper analytics; see <Link href="/pricing">Pricing</Link>.
        Attendees use the Blend&apos;n app, at <a href="https://www.blendn.app">www.blendn.app</a>.
      </p>

      <h2>The company</h2>
      <p>
        {COMPANY.legalName}
        <br />
        {COMPANY.address}
      </p>
      <p>
        To reach us, see <Link href="/contact">Contact</Link>.
      </p>
    </PolicyPage>
  )
}
