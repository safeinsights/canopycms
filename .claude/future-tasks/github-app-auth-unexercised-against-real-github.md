# [P2] The GitHub App auth path has never run against real GitHub — exercise it with `init-github-app`

Filed 2026-09-13 while landing `canopycms init-github-app` (PR #333). Scoped **out** of that
PR deliberately: it needs account-owner rights and a live deployment, and folding it in would
make a testable PR depend on a manual one.

## The gap

Adopter request #45 (#321) and its CDK half (#329) shipped GitHub App authentication for the
worker. Every part of it is covered by unit tests with a mocked Octokit, and **none of it has
ever authenticated to github.com.** Specifically unproven against the real service:

- that `createAppAuth` + `normalizeGitHubAppPrivateKey` produce a JWT GitHub accepts, at the
  `@octokit/auth-app@6` → `universal-github-app-jwt@1` resolution the worker actually bundles
  (`packages/canopycms/src/worker/github-auth.ts:345-361` records why that resolution, not the
  key, is the variable);
- that `buildGitHubUrl()`'s `https://x-access-token:<token>@github.com/…` form is accepted for
  clone, fetch and `--force-with-lease` push by an **installation** token
  (`worker/cms-worker.ts:817-820`);
- that `contents: write` + `pull_requests: write` is genuinely sufficient — in particular for
  the two **GraphQL** mutations, which is the one entry in `CANOPY_APP_PERMISSIONS` derived by
  analogy rather than from GitHub's permissions reference (that reference enumerates REST
  endpoints only);
- that `preflightGitHubAppAuth()`'s boot mint works and that
  `isTransientAuthFailure()` classifies a real GitHub failure the way it classifies a
  synthesised one (`worker/cms-worker.ts:856-880`).

## Why it matters more than "untested feature"

The failure is quiet. `task-runner.ts:387-403` (`convert-to-draft`) runs a GraphQL mutation,
and a GraphQL failure answers HTTP 200 with a body-level error carrying **no numeric status** —
so `isPermanentTaskFailure` reads a permission denial as transient, retries to the cap, and
wedges the branch in `sync-failed` with nothing naming a permission. And
`github-service.ts:238-243` swallows a failed `markPullRequestReadyForReview` into a warning by
design, leaving the PR stuck as a draft.

## What to do

`canopycms init-github-app` (`packages/canopycms/src/cli/init-github-app.ts`) is the natural
way to set this up, and running it is itself half the test — the manifest conversion, the
34-character name limit, whether `redirect_url` really is required despite being documented
optional, and the 422-on-unapproved-permission behaviour are all browser- and owner-gated and
can never run in CI.

1. `canopycms init-github-app create --owner canopycms --repo deploy-test -- <a command that
   stores the key>` against the `canopycms` org's `deploy-test` repo. Record what GitHub
   actually did with the name length and with `redirect_url`.
2. `canopycms init-github-app verify --app-id <id> --key-file <path>` and confirm the readback
   reports `repository_selection: selected` and exactly the three declared permissions.
3. Point the deployed worker at the App (`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
   `GITHUB_APP_PRIVATE_KEY_SECRET_ARN`, with `GITHUB_TOKEN_SECRET_ARN` removed) and drive one
   full publish: submit an edit, watch the branch push and the PR open, withdraw it to exercise
   `convert-to-draft`, resubmit to exercise `markPullRequestReadyForReview`.
4. **Then narrow it deliberately** — drop the installation to `pull_requests: read` and confirm
   `verify` catches it, and that the worker's failure looks the way this file predicts. That is
   the half that proves `verify` is worth having.

## What to write down afterwards

Re-measure `APP_NAME_MAX_LENGTH` (34 is carried over from a sibling project's measurement; the
true bound is somewhere in 33–38) and `APP_SUMMARY_MAX_LENGTH` (37, same provenance), and
either confirm or correct the GraphQL permission entry in `CANOPY_APP_PERMISSIONS` — its
comment currently says outright that a live run is the oracle.

Pairs with [github-service-static-token-only.md](github-service-static-token-only.md): if that
gap ever closes, `GitHubService` acquires a second App-authenticated path and the permission
derivation would need re-checking against it.
