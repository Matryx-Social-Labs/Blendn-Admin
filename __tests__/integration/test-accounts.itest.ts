import bcrypt from "bcryptjs"

import { actorFor } from "@/lib/org-membership"
import { eventPermissionSelect, eventPermissions } from "@/lib/rbac"
import {
  ensureTestAccounts,
  environmentRefusal,
  skipReason,
  TEST_ACCOUNTS,
  type TestAccountsWorld,
} from "@/scripts/test-accounts"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/*
 * The accounts people sign in as to look at the dashboard, written on every
 * staging deploy by `railway.json`'s pre-deploy step.
 *
 * Every case runs against its own namespaced world rather than the real
 * addresses: jest shares one database here, and locally that is the same
 * database `seed:qa` fills — a suite that upserted and then deleted
 * `admin@blendn.app` would sign the developer out of their own fixture.
 */

const PASSWORD = "correct-horse-battery-2026"
const tags: string[] = []
const eventIds: string[] = []

function worldFor(label: string): TestAccountsWorld {
  const tag = testId(label)
  tags.push(tag)
  return {
    accounts: TEST_ACCOUNTS.map((a) => ({
      ...a,
      email: `${tag}-${a.key}@itest.invalid`,
      formerly: `${tag}-old-${a.key}@itest.invalid`,
    })),
    orgNames: { events: `${tag} events`, venues: `${tag} venues`, brands: `${tag} brands` },
    retired: [`${tag}-retired@itest.invalid`],
  }
}

const byKey = (world: TestAccountsWorld, key: string) => {
  const account = world.accounts.find((a) => a.key === key)
  if (!account) throw new Error(`no ${key} in world`)
  return account
}

afterAll(async () => {
  const users = await db.user.findMany({
    where: { OR: tags.map((t) => ({ email: { startsWith: t } })) },
    select: { id: true },
  })
  const orgs = await db.organisations.findMany({
    where: { OR: tags.map((t) => ({ display_name: { startsWith: t } })) },
    select: { id: true },
  })
  const orgIds = orgs.map((o) => o.id)
  await cleanup(
    users.map((u) => u.id),
    eventIds
  )
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgIds } } })
  await db.organisations.deleteMany({ where: { id: { in: orgIds } } })
  await closeDb()
})

const LOCAL_DB = "postgresql://postgres:postgres@localhost:55433/blendn_test"
const REMOTE_DB = "postgresql://postgres:x@shuttle.proxy.rlwy.net:41234/railway"

describe("environmentRefusal — an allow-list, not a deny-list", () => {
  it("allows staging, and a database on this machine", () => {
    expect(environmentRefusal({ RAILWAY_ENVIRONMENT_NAME: "staging", DATABASE_URL: REMOTE_DB })).toBeNull()
    expect(environmentRefusal({ DATABASE_URL: LOCAL_DB })).toBeNull()
    expect(environmentRefusal({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db" })).toBeNull()
  })

  it("refuses production — a shared-password admin there reads real people's data", () => {
    expect(environmentRefusal({ RAILWAY_ENVIRONMENT_NAME: "production", DATABASE_URL: REMOTE_DB })).toMatch(/production/)
    expect(environmentRefusal({ RAILWAY_ENVIRONMENT_NAME: "production", DATABASE_URL: LOCAL_DB })).not.toBeNull()
  })

  it("refuses what a deny-list let through: a renamed environment, and a remote URL in a laptop shell", () => {
    expect(environmentRefusal({ RAILWAY_ENVIRONMENT_NAME: "prod", DATABASE_URL: REMOTE_DB })).toMatch(/prod/)
    expect(environmentRefusal({ DATABASE_URL: REMOTE_DB })).toMatch(/shuttle\.proxy\.rlwy\.net/)
  })
})

describe("skipReason — when the pre-deploy step writes nothing", () => {
  it("skips without a password, so an environment that never set one is untouched", () => {
    expect(skipReason({ RAILWAY_ENVIRONMENT_NAME: "staging" })).toMatch(/SEED_PASSWORD/)
    expect(skipReason({ DATABASE_URL: LOCAL_DB, SEED_PASSWORD: "   " })).toMatch(/SEED_PASSWORD/)
  })

  it("skips any environment that is not staging — production and PR environments deploy untouched", () => {
    expect(skipReason({ RAILWAY_ENVIRONMENT_NAME: "production", SEED_PASSWORD: PASSWORD })).toMatch(/production/)
    expect(skipReason({ RAILWAY_ENVIRONMENT_NAME: "blendn-pr-42", SEED_PASSWORD: PASSWORD })).toMatch(/pr-42/)
  })

  it("runs on staging with a password", () => {
    expect(skipReason({ RAILWAY_ENVIRONMENT_NAME: "staging", SEED_PASSWORD: PASSWORD })).toBeNull()
  })
})

describe("ensureTestAccounts", () => {
  it("refuses from every caller on production, not only the deploy step", async () => {
    const world = worldFor("prod")
    const saved = process.env.RAILWAY_ENVIRONMENT_NAME
    process.env.RAILWAY_ENVIRONMENT_NAME = "production"
    try {
      await expect(ensureTestAccounts(db, PASSWORD, world)).rejects.toThrow(/REFUSING/)
    } finally {
      if (saved === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME
      else process.env.RAILWAY_ENVIRONMENT_NAME = saved
    }

    const written = await db.user.count({ where: { email: { in: world.accounts.map((a) => a.email) } } })
    expect(written).toBe(0)
  })

  it("refuses a password the product would refuse, before writing anything", async () => {
    const world = worldFor("weak")

    await expect(ensureTestAccounts(db, "short", world)).rejects.toThrow(/SEED_PASSWORD/)
    await expect(ensureTestAccounts(db, "password12345!", world)).rejects.toThrow(/SEED_PASSWORD/)

    const written = await db.user.count({ where: { email: { in: world.accounts.map((a) => a.email) } } })
    expect(written).toBe(0)
  })

  it("builds each account with the access its role needs — a role without an org is an empty dashboard", async () => {
    const world = worldFor("fresh")

    const { users, orgs } = await ensureTestAccounts(db, PASSWORD, world)

    for (const account of world.accounts) {
      const user = await db.user.findUniqueOrThrow({
        where: { email: account.email },
        include: { profile: true, org_memberships: { include: { org: true } } },
      })
      expect(user.id).toBe(users[account.key])
      expect(user.role).toBe(account.role)
      expect(user.emailVerified).not.toBeNull()
      expect(await bcrypt.compare(PASSWORD, user.password ?? "")).toBe(true)
      expect(user.profile?.name).toBe(account.name)

      if (account.org) {
        expect(user.org_memberships).toHaveLength(1)
        expect(user.org_memberships[0].role).toBe("owner")
        expect(user.org_memberships[0].org.display_name).toBe(world.orgNames[account.org])
        expect(user.org_memberships[0].org.status).toBe("verified")
      } else {
        expect(user.org_memberships).toHaveLength(0)
      }
    }
    expect(orgs.events.display_name).toBe(world.orgNames.events)
  })

  it("renames the old persona in place, so everything it owned comes with it", async () => {
    const world = worldFor("rename")
    const organiser = byKey(world, "organiser")
    const oldId = await makeUser("old-organiser", "organizer")
    await db.user.update({ where: { id: oldId }, data: { email: organiser.formerly } })
    const eventId = await makeEvent(oldId)
    eventIds.push(eventId)

    const { users } = await ensureTestAccounts(db, PASSWORD, world)

    expect(users.organiser).toBe(oldId)
    expect(await db.user.findUnique({ where: { email: organiser.formerly } })).toBeNull()
    const event = await db.events.findUniqueOrThrow({ where: { id: eventId } })
    expect(event.organizer_id).toBe(oldId)
  })

  it("leaves both rows alone when the new address already exists, rather than guessing which to keep", async () => {
    const world = worldFor("clash")
    const admin = byKey(world, "admin")
    const oldId = await makeUser("clash-old", "app_admin")
    await db.user.update({ where: { id: oldId }, data: { email: admin.formerly } })
    const newId = await makeUser("clash-new", "app_admin")
    await db.user.update({ where: { id: newId }, data: { email: admin.email } })

    const { users } = await ensureTestAccounts(db, PASSWORD, world)

    expect(users.admin).toBe(newId)
    const old = await db.user.findUniqueOrThrow({ where: { id: oldId } })
    expect(old.email).toBe(admin.formerly)
    expect(old.suspended_at).toBeNull()
  })

  it("retires the old accounts and hands their live events to the organiser, who can then edit them", async () => {
    const world = worldFor("retire")
    const retiredId = await makeUser("retired", "organizer")
    await db.user.update({ where: { id: retiredId }, data: { email: world.retired[0] } })
    const live = await makeEvent(retiredId)
    const gone = await makeEvent(retiredId, { deleted_at: new Date() })
    eventIds.push(live, gone)
    // Remembered by a suspension of the OLD organisation.
    await db.events.update({ where: { id: live }, data: { pre_suspension_status: "published" } })

    const { users, orgs } = await ensureTestAccounts(db, PASSWORD, world)

    const retired = await db.user.findUniqueOrThrow({ where: { id: retiredId } })
    expect(retired.suspended_at).not.toBeNull()
    expect(retired.suspension_reason).toMatch(/test-accounts/)

    const adopted = await db.events.findUniqueOrThrow({
      where: { id: live },
      select: { organizer_id: true, ...eventPermissionSelect },
    })
    expect(adopted.organizer_id).toBe(users.organiser)
    expect(adopted.organizer_org_id).toBe(orgs.events.id)
    const memory = await db.events.findUniqueOrThrow({ where: { id: live }, select: { pre_suspension_status: true } })
    expect(memory.pre_suspension_status).toBeNull()

    // Through the real resolver: moving the row is only half of it if the
    // organiser still cannot touch the event.
    const actor = await actorFor({ id: users.organiser, role: "organizer" })
    expect(eventPermissions(actor, adopted).canEdit).toBe(true)

    const untouched = await db.events.findUniqueOrThrow({ where: { id: gone } })
    expect(untouched.organizer_id).toBe(retiredId)
  })

  it("puts back the access a tester broke — role, suspension, membership — and leaves an unchanged password's hash alone", async () => {
    const world = worldFor("repair")
    const { users } = await ensureTestAccounts(db, PASSWORD, world)
    const before = await db.user.findUniqueOrThrow({ where: { id: users.venue } })
    await db.user.update({
      where: { id: users.venue },
      data: { role: "attendee", suspended_at: new Date() },
    })
    await db.organisation_members.deleteMany({ where: { user_id: users.venue } })
    await db.organisation_members.updateMany({ where: { user_id: users.organiser }, data: { role: "staff" } })

    await ensureTestAccounts(db, PASSWORD, world)

    const after = await db.user.findUniqueOrThrow({
      where: { id: users.venue },
      include: { org_memberships: true },
    })
    expect(after.role).toBe("venue_owner")
    expect(after.suspended_at).toBeNull()
    expect(after.org_memberships).toHaveLength(1)
    expect(after.password).toBe(before.password)
    const organiserMembership = await db.organisation_members.findFirstOrThrow({
      where: { user_id: users.organiser },
    })
    expect(organiserMembership.role).toBe("owner")
  })

  it("leaves a suspended organisation suspended — reinstating is the admin screen's job, and it restores the events", async () => {
    const world = worldFor("orgsusp")
    const { orgs } = await ensureTestAccounts(db, PASSWORD, world)
    await db.organisations.update({ where: { id: orgs.events.id }, data: { status: "suspended" } })

    await ensureTestAccounts(db, PASSWORD, world)

    const org = await db.organisations.findUniqueOrThrow({ where: { id: orgs.events.id } })
    expect(org.status).toBe("suspended")
  })

  it("moves every account to a new password when the variable changes", async () => {
    const world = worldFor("rotate")
    const { users } = await ensureTestAccounts(db, PASSWORD, world)

    await ensureTestAccounts(db, "a-different-secret-2026", world)

    const user = await db.user.findUniqueOrThrow({ where: { id: users.sponsor } })
    expect(await bcrypt.compare("a-different-secret-2026", user.password ?? "")).toBe(true)
    expect(await bcrypt.compare(PASSWORD, user.password ?? "")).toBe(false)
  })
})
