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

## Promote to staging — fast-forward, never merge
`dev` → `staging` is a **fast-forward push**, not a merge (a `--merge` once
accumulated 34 phantom commits):

    git fetch origin dev staging
    git merge-base --is-ancestor origin/staging origin/dev   # must be true
    git push origin origin/dev:staging

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
