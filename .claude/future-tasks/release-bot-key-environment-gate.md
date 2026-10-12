---
priority: P2
adopters: NEITHER
summary: >-
  RELEASE_BOT_PRIVATE_KEY is a plain repository secret, so any workflow on any branch can mint the release-bot app token, which the org's require-pr ruleset lets bypass PR review on main and stable-tags-release-bot-only lets create vX.Y.Z. Gate it behind a `release` environment restricted to main (JP settings action plus one line in publish.yml)
---
# Gate the release-bot key behind a main-only environment

Found by the Fable full-diff review of changesets PR B (2026-10-11). This existed before PR B,
which only narrowed where the token is minted.

## The gap

- `GET /repos/safeinsights/canopycms/actions/secrets` lists `RELEASE_BOT_PRIVATE_KEY` as a
  repository secret. The only environment is `copilot`.
- Any workflow file on any branch can call `actions/create-github-app-token` with that key.
- The resulting token belongs to app 4038189. The org ruleset `require-pr` (7484436) lets that
  app bypass PR review on `main`, and `stable-tags-release-bot-only` (24895274) lets it create
  stable tags.
- So anyone who can push a branch with a workflow can push to `main` without review.

## Fix

1. **JP, in repository settings:**
   - create an environment `release` with a deployment-branch policy of `main` only;
   - move `RELEASE_BOT_PRIVATE_KEY` into it;
   - delete the repository-level secret.
2. **In `.github/workflows/publish.yml`:** add `environment: release` to the `release-commit`
   job. Nothing else uses the key.
3. **Optionally:** bind each package's npm trusted publisher to the same environment name.

Check afterwards that a branch workflow can no longer read the secret.
