# Prod mode assumes 'main' when defaultBaseBranch is unset — detect the remote's real default branch

## Priority: P3

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
