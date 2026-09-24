---
description: One-time check that this machine and this developer can run the Blendn test programme; reports what is missing
argument-hint: "[your initials, e.g. sk]"
---

You are preparing this machine for the Blendn test programme. Read
`docs/agents/TEST-PLAN.md` first — it is the programme; this command only checks
the prerequisites. Do not start testing here; that is `/tq-next`.

Developer initials (for the session tag): $ARGUMENTS

Check each item below, fix what you can without asking (installs that need a
password or a login, ask), and finish with a table: item · status · what the
developer must do. Never print a secret; confirm a variable exists without
echoing its value.

## 1 · Repos

- This repo (`blendn-admin`) is on a branch from a fresh `origin/dev`.
- The Expo client repo (`blendn`) is checked out on this machine. Ask for its path
  if you cannot find it next to this repo, and remember it for the session. It
  must contain `.maestro/journeys/` (Blendn PR #271) — if not, say so.

## 2 · Command-line tools

| Tool | Check | Why |
|---|---|---|
| Node deps | `npm ci` done, `npm run -s qa` prints usage | the `qa` tool |
| Railway CLI | `railway whoami`, and `railway variables --environment staging --service Blendn-Admin --json` has `SEED_PASSWORD` (do not print it) | staging DB URL, the shared password |
| GitHub CLI | `gh auth status` | PRs |
| Maestro CLI | `maestro --version` (2.10+) and a JDK 17 or 21 for it | driving the app |
| jq | `jq --version` | the re-seed one-liner |
| Docker | `docker ps` shows `blendn-pg17` on 55433, or can start it | integration tests |
| Xcode + a booted iOS simulator, and/or the Android SDK with the `Blendn_A34` AVD | `xcrun simctl list devices booted` / `adb devices` | the app surfaces (see `docs/agents/reference/environment.md` for the AVD recipe) |

Then run `npm run -s qa bootstrap` — it must print `staging DB reachable`.

## 3 · Claude Code: MCP servers

- **atlassian** — `claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp/authv2`, then authorise in an interactive session (`/mcp`). Test: read SCRUM-208.
- **maestro** — `claude mcp add maestro -- maestro mcp`. Test: `list_devices`.

## 4 · Claude Code: skills and agents the programme uses

Confirm each is available in this session's skill/agent list; list the missing ones.

| Surface / step | Skill or agent |
|---|---|
| Dashboard driving | gstack **browse** (`~/.claude/skills/gstack/browse/dist/browse`; install gstack and run its `./setup` if absent) |
| Root cause of a finding | gstack **investigate** |
| Dashboard design gate (before editing a screen) | **ecc:dashboard-builder**, **ecc:frontend-design-direction**, **design-html** |
| Review before merge | **ecc:pr-test-analyzer** (every PR), **ecc:security-reviewer** (auth, authz, user data), **ecc:database-reviewer** (schema, queries), **ecc:react-reviewer** (UI) |
| Jira | the atlassian MCP (above) |

The ECC agents come from the `ecc` Claude Code plugin; gstack from its own repo
install. If either is missing, tell the developer — do not try to substitute.

## 5 · The developer's identity in the programme

- Session tag format: `<initials>-<MMDD><letter>`, e.g. `sk-0924a`. One per session.
- Lane: read the latest `LANE` comments on SCRUM-208 and propose a free lane
  (TEST-PLAN.md §3). Do not claim it yet — `/tq-next` does.

End with: "Ready — run `/tq-next <tag>`" or the list of what is missing.
