---
priority: adopter-side
adopters: BOTH
summary: >-
  Each adopter protects its CMS base branch (and the production branch it cuts over to) with branch protection or a ruleset that the CMS's GitHub credential cannot bypass. Until the worker refuses every push to the base branch, that protection is the only guard against a compromised CMS writing to the branch a site deploys from; afterwards it stays as defense in depth
---

# Adopters: protect the base branch from the CMS's own credential

**Adopter-side work, tracked here for visibility.** Do it now, on every adopter repository,
before the package fix ships and regardless of it.

## Why

The CMS worker holds a GitHub credential that can push. The base branch is the one each site's
deploy workflow builds from, so a commit that reaches it ships. Before the package fix, the
worker would push to the base branch when asked to, and a compromised CMS Lambda can make that
request. A worker that refuses those pushes closes it in the package. Protection on the branch,
enforced against the credential itself, closes it on GitHub, and keeps closing it if some later
code path regresses.

## What to check, per adopter repository

- The base branch (`defaultBaseBranch`, or the repository's default branch when that's unset),
  and the branch a cutover moves it to (for example `production`), each have branch protection
  or a ruleset requiring a pull request, with force pushes and deletion blocked.
- The CMS's credential cannot bypass it:
  - A classic personal access token belonging to a repository admin usually CAN bypass classic
    branch protection, unless "Do not allow bypassing the above settings" is on, or a ruleset
    lists no bypass actor that the token's user or app holds.
  - A GitHub App installation token is bound by rulesets unless the app is a bypass actor.
- Verify it with the credential itself, against a throwaway branch protected the same way: a
  direct push and a force push should both be rejected.

## Status

- **Marketing site, checked 2026-10-10 by reading its rulesets:** its current base branch is
  protected by rulesets that block deletion and force-push, require a pull request, and give the
  CMS's GitHub App no bypass. Its GitHub default branch is likewise closed to the CMS. **Open:**
  the `production` branch its cutover moves to does not exist yet. It needs the same rulesets,
  with no bypass for the CMS's app, when it is created and before the cutover.
- **Knowledge base:** not checked. KB work is paused for several weeks from 2026-10-10.

## Done when

Every adopter repository has passed the check above, recorded in that adopter's own repo. This file then
moves to `resolved/`.

## Related

- [worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md), whose plan
  found the gap and whose gateway enforces the protected set in the package.
