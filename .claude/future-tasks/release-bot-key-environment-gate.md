---
priority: P2
adopters: NEITHER
summary: >-
  CODE HALF DONE (branch chore/release-bot-key-environment): publish.yml's release-commit job, the only user of RELEASE_BOT_PRIVATE_KEY, names `environment: release`. OPEN, JP's settings: create the `release` environment limited to branch main, move the key into it, delete the repository secret (steps in DEVELOPING.md "Releasing"). Move to resolved/ once JP confirms
---
# Gate the release-bot key behind a main-only environment

Found by the Fable full-diff review of changesets PR B (2026-10-11). This existed before PR B,
which only narrowed where the token is minted.

## The gap

- `GET /repos/safeinsights/canopycms/actions/secrets` lists `RELEASE_BOT_PRIVATE_KEY` as a
  repository secret. No deployment environment gates it yet.
- Any workflow file on any branch can call `actions/create-github-app-token` with that key.
- The resulting token belongs to the release bot app. The org's require-PR ruleset lets that
  app bypass PR review on `main`, and the stable-tags ruleset lets it create stable tags.
- So anyone who can push a branch with a workflow can push to `main` without review.

## Fix

1. **Done, in code.** `release-commit` in `.github/workflows/publish.yml` names
   `environment: release`. Nothing else reads the key: `publish` holds only npm's id-token,
   `prerelease` uses no secrets, and `tag-prerelease` uses `GITHUB_TOKEN`. Landing this first breaks nothing,
   because a job in an environment still sees repository secrets, and a run that names a missing
   environment creates it, unprotected.
2. **Open, JP, in repository settings:** the numbered steps under "The release-bot key" in
   [DEVELOPING.md](../../DEVELOPING.md#releasing). In short: environment `release`, deployment
   branches **Selected branches and tags** with one **Branch** rule `main` (no tag rule, since
   `release-commit` only runs on a push to `main`), the key as an environment secret, and the
   repository secret deleted. Delete it only once this change is on `main`: until then, `main`'s
   `release-commit` names no environment and reads the repository secret.
3. **Optionally:** bind each package's npm trusted publisher to an environment too. That needs
   `publish` to name one that allows `v*` tags, so it is a separate change.

Check afterwards: `gh api repos/safeinsights/canopycms/actions/secrets` no longer lists the key,
`gh api repos/safeinsights/canopycms/environments/release/secrets` does, and the next stable
release's `release-commit` still pushes.
