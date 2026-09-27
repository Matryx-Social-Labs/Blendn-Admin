# Routine: landing a change and promoting to staging

## Branch and PR
- Branch from `origin/dev` (never continue on a squash-merged branch).
- Lint before the PR. Keep the diff focused; one concern per PR.
- End commit messages and PR bodies with the project's co-author / generated-by
  lines (see existing commits).

## Merge into dev
Squash-merge into `dev`:

    gh pr merge <n> --squash --delete-branch

If several PRs touch the same file (e.g. `docs/API.md`,
`negative-controls.json`, the checklist), merge one at a time and re-check the
others' mergeability after each.

## Promote to staging — a pull request from dev, merged
Since 2026-09-27 a ruleset decides (#464): `staging` and `prod` take changes only
by pull request, merged with a **merge commit**, and the required check
`promotion source` passes only when the head is `dev` (or `staging`, into
`prod`). A push, a squash, and a side branch are all refused:

    gh pr create --base staging --head dev --title "promote: staging = dev at <sha> — <what>"
    gh pr merge <n> --merge

Staging carries merge commits `dev` never sees, so compare content, not commit
counts: `git diff origin/dev origin/staging` is empty after a promotion.

Railway auto-deploys `staging` and auto-runs `prisma migrate deploy`. **Never
hand-apply a migration** — the deploy runs it and dies on the next boot if you
did.

## Verify the deploy
Poll the deploy, then health:

    railway deployment list --environment staging --service blendn-admin --json
    curl -s https://staging-api.blendn.app/api/health

Then **re-drive or read back the fix on staging** — that is what turns a ticket
from In Review to Done.

## Client changes
The Expo client ships through an app-store / dev-client build, not a promote.
A client fix that was only driven locally stays **In Review** until the next
client build; note that on the ticket. Native config changes (manifest, keys,
plugins) need a full rebuild, not a Metro reload.
