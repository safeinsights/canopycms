---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED 2026-10-10, branch `fix/settings-push-reports-unmoved`, base `int-202610-b`. The
  gateway's push reads `git push --porcelain` and returns `{ moved: false }` or
  `{ moved: true, from, to }` with `pastStaleLease`. Both push logs say `Pushed … to GitHub
  (<old7>..<new7>)` (or `new branch at <new7>`) only when the ref moved, and `already up to date on GitHub` at debug level
  otherwise. The sync loop skips the settings push outright when this cycle's fetch already shows
  GitHub at the local head, so an unchanged branch costs no GitHub round trip.
---
# "Pushed settings branch" is logged even when nothing moved

**Status: RESOLVED 2026-10-10**, branch `fix/settings-push-reports-unmoved`; see the summary.

**Priority:** P2 [BOTH]. **Found:** adopter request 108.

## What the adopter saw

Over 15 minutes the worker logged `Pushed settings branch canopycms-settings-<tier> to GitHub` at
every 5-minute sync, while the branch tip on GitHub never moved and GitHub recorded no rule suite
for the ref. Every "push" was a no-op that never reached a ruleset, and an operator concluded,
wrongly, that the rulesets had let the App's push through.

## Why

`pushSettingsBranches` (`worker/git-sync.ts`) logged success unconditionally after the push.
`pushToGitHub` (`worker/github-mirror.ts`) returned `Promise<void>`, and `git push` of a ref GitHub
already holds exits 0 ("Everything up-to-date"). Each cycle also paid a default-branch read, a fetch
and a push round trip for an unchanged branch. The task runner's push log had the same shape.

## What changed

- `MirrorSession.pushToGitHub` runs `git push --porcelain` and parses the ref's status flag
  (`parsePushStatus`): `=` up to date, ` ` fast-forward, `+` forced, `*` new branch. A line it
  cannot read throws rather than report a push it did not see. `GitHubGateway.push` returns that as
  `GitHubPushOutcome`, so an out-of-process gateway carries it too.
- `pushSettingsBranches` receives GitHub's tips as fetched this cycle (`trackedTips`) and skips
  the gateway entirely when the settings tip equals the local head. #490's refusal checks are
  unchanged and still run for every push that happens.
- The task runner logs moved vs unmoved the same way, and its settings-branch step no longer
  claims a push of its own.
