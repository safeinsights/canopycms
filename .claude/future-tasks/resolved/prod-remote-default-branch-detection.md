---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, fix/prod-default-branch-detection. Prod no longer assumes `'main'` when `defaultBaseBranch` is unset: the Lambda reads the base branch from `remote.git`'s HEAD (`GitManager.detectBaseBranch`, a local read), the worker detects its own (remote.git HEAD, or GitHub's default before remote.git exists) and points remote.git's HEAD at the branch it uses, and the CDK stamps `CANOPYCMS_BASE_BRANCH` only when `baseBranch` is set. Before the worker creates remote.git the base branch stays pending and each request retries it behind the not-ready 503 (`resolvePendingBaseBranch`); an unreadable HEAD or a network remote fails service creation naming `defaultBaseBranch`. Dev mode is unchanged. Following a later change of GitHub's default branch is split to [worker-boot-default-branch-refresh.md](../worker-boot-default-branch-refresh.md)
---
# Prod mode assumes 'main' when defaultBaseBranch is unset — detect the remote's real default branch

## Status: RESOLVED 2026-10-09

## Priority: P2

Surfaced by the protected-base-branch work (2026-07-24), from JP's question about
repos whose base is `master`/`develop`. The protection predicate correctly keys off
the resolved `config.defaultBaseBranch`, but the resolution itself hard-falls-back
to `'main'` in prod when the adopter didn't set it.

## Problem

`resolveBaseBranch()` (utils/git.ts) and the service-creation baking
(services.ts) resolve the base branch as: explicit config → dev-mode git HEAD →
`'main'`. In prod there is no detection: an adopter whose repo default branch is
`master` and who forgets `defaultBaseBranch: 'master'` gets a CMS that forks,
rebases, PRs, and now protects against a nonexistent `main`. Everything
downstream (workspace seeding, PR bases, protection) inherits the wrong value, so
today the misconfiguration fails scattered and late instead of loudly at startup.

## Fix sketch

In prod mode when `defaultBaseBranch` is unset, detect the remote's default
branch once at service creation (`git symbolic-ref refs/remotes/origin/HEAD` on
the seeded clone, or `ls-remote --symref origin HEAD` — no GitHub API needed) and
bake that instead of `'main'`. Fall back to `'main'` only when detection fails,
with a logged warning. Alternatively (cheaper): fail config validation in prod
when unset and the remote's HEAD disagrees with `'main'`. Static deployments must
keep skipping git entirely.

## Related

- `utils/git.ts` `resolveBaseBranch()` — the canonical resolver
- ARCHITECTURE.md "Branch Identity" detection matrix (documents the prod
  `'main'` fallback)
- `authorization/protected-branch.ts` — consumes the resolved value
