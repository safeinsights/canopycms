# [P1] Publishing a rebased branch is refused once the base branch changes a workflow file

Found 2026-09-13 by review round 1 of the worker-credential epic (the `init-github-app` CLI
reviewer), and **needs a decision from JP** before any code changes. It predates the epic
for the documented PAT; what the epic added is a CLI check that blocks one of the fixes.

## What happens

GitHub refuses a push that "creates or updates" a file under `.github/workflows/` unless
the credential carries the workflows permission: `workflows: write` for a GitHub App,
the `workflow` scope for a classic PAT. **The pusher does not have to have edited the
file.** A branch rebased onto a base that changed a workflow is refused too:

- [dianlight/hassio-addons#752](https://github.com/dianlight/hassio-addons/issues/752):
  `devrelease/besim` was rebased onto `origin/master`, which had changed
  `.github/workflows/docker-image-dev.yml`. The push with an App installation token was
  refused with "refusing to allow a GitHub App to create or update workflow
  `.github/workflows/docker-image-dev.yml` without `workflows` permission".
- [aormsby/Fork-Sync-With-Upstream-action#44](https://github.com/aormsby/Fork-Sync-With-Upstream-action/issues/44):
  the same refusal when syncing a fork brought in upstream workflow changes.

That is the CanopyCMS worker's normal operation. The rebase loop replays content branches
onto the base, and the publish task pushes the result to GitHub in `pushBranchToGitHub`
(`packages/canopycms/src/worker/task-runner.ts`), under `--force-with-lease` when history
was rewritten and as a plain push otherwise.

**Not measured here.** The two reports above are the evidence; nothing in this repo has
pushed a rebased branch across a workflow change to real GitHub. In particular, which
comparison GitHub makes for a branch that has never been published (no old tip) is
unknown.

## Why it is P1

- **It fails in the worst way.** The refusal is a git error with no HTTP `.status`, so
  `isPermanentTaskFailure` classifies it transient. The task burns its retries and the
  branch ends in `sync-failed`, with a `syncFailureReason` quoting git's text and nothing
  telling the editor what to do.
- **Base-branch workflow edits are routine.** An action re-pin touches every workflow
  file (see `resolved/gha-actions-node20-runtime.md`). After each one, every content branch
  that rebases across it can no longer publish.
- **Every credential shape is affected:**
  - The documented PAT is "GitHub PAT with `repo` scope" (`docs/deploying-to-aws.md`,
    Step 6), and `repo` does not include `workflow`.
  - The App that `init-github-app create` registers holds exactly `contents: write`,
    `pull_requests: write` and `metadata: read` (`CANOPY_APP_PERMISSIONS` in
    `packages/canopycms/src/cli/init-github-app.ts`). The comment above it justifies
    leaving `workflows` out with "nothing writes under `.github/workflows/`", which is
    true of the worker's own edits but not of the history it pushes.
  - Per the reviewer, `verify` (and `create`'s readback) reports a held permission
    outside that set as an error. So an adopter who grants `workflows` to fix this gets a
    failing `verify`.

## The decision

1. **Grant the workflows permission** (App `workflows: write`, PAT `workflow` scope) and
   teach `verify` to accept it. This fixes publishing but widens the credential's reach
   to CI: a leaked worker credential could rewrite a workflow and run code with the
   repository's Actions secrets, which for a CanopyCMS site include the AWS deploy role.
   One App per site bounds that to one repository; it does not remove it.
2. **Stay least-privilege, and fail legibly.** Recognise the refusal text in
   `pushBranchToGitHub`, raise `PermanentTaskError` with a reason that names the workflow
   file and says a human must push or merge the base, and document it. No retry burn, and a
   message the editor can act on, but those branches still cannot publish on their own.
3. **Stop pushing history that carries base workflow changes.** For example, skip the
   rebase for a branch when the base commits it would replay onto touch
   `.github/workflows/`, and let the PR surface conflicts instead. This keeps least
   privilege and keeps publishing working, but changes the rebase loop's contract, and it
   still leaves the question of what happens at merge.

Option 2 is cheap and safe to do regardless of the choice between 1 and 3.

## Before implementing anything

Measure it: add a rebase across a base-branch workflow change, followed by a publish, to
the live run in [github-app-auth-unexercised-against-real-github.md](github-app-auth-unexercised-against-real-github.md).
Also check whether a first publish of a never-pushed branch is refused, and do the same
with a fine-grained and a classic PAT.
