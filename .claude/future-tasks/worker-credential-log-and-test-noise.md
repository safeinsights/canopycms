# [P3] Worker credential logging says less than it knows, and one CLI test writes to stderr

Found 2026-09-13 during the worker-credential epic's review and claims pass. These are three small
code-level items the claims pass could not fix, because it corrects prose only.

## 1. The Secrets Manager retry log line hides the error

`fetchSecretString` in `packages/canopycms-cdk/worker/secrets.ts` logs
`Secrets Manager unavailable for <arn>, retrying in <n>ms...` for every failed `client.send`. That
covers a transport failure, a per-attempt deadline abort, an `AccessDeniedException` and a
`ResourceNotFoundException` alike. The message names no error, so an IAM misconfiguration reads like
an outage for the ~7 seconds of retries. The final rethrow does carry the real error.

Include the error's name or code, never its message body, in the retry line. For example:
`… retrying in 1000ms (AccessDeniedException)`.

## 2. "Failed to re-read the GitHub credential" is logged for a read that later succeeds

`CmsWorker.refreshGitHubCredential` (`packages/canopycms/src/worker/cms-worker.ts`) races the
provider against `taskTimeoutMs`. When the race loses, it logs
`Failed to re-read the GitHub credential after a failure: the re-read did not settle within <n>ms`.
The abandoned read is not cancelled, though, and may land a moment later and swap the rotated token
in. The start-order guard in `github-auth.ts` keeps that safe. The log then says "failed" about a
refresh that worked.

Word the timeout case as "not settled within <n>ms; it may still complete", or log the late success
when it lands.

## 3. The exit-127 bridge test writes to the test runner's stderr

`packages/canopycms/src/cli/init-github-app.test.ts`, test "reports a command that is not on PATH by
its exit 127…", spawns a real `env canopycms-test-no-such-command`. The destination's stderr is
`inherit`, so `env: canopycms-test-no-such-command: No such file or directory` is written straight to
the runner's fd 2. `vitest.shared.ts`'s CI log guard sees only console calls, so it never fails, but
every run's output gets that line.

Either pass a destination whose failure is silent, or make stdio injectable for the test.
