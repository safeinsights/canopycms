# [P3] A secret the worker cannot read or parse at boot crash-loops with nothing in worker-status.json

Found 2026-09-13 by review round 1 of the worker-credential epic (the CDK/secrets reviewer).

## What happens

`packages/canopycms-cdk/worker/index.ts` reads every secret with `await getSecret(...)` inside
`main()` before `worker.start()`: the GitHub token, the App private key and the Clerk key. A
throw there reaches `main().catch`, which logs and exits 1. `lastFatalError` is written only in
`CmsWorker.start()`'s catch, so the admin panel shows the worker as absent with no reason, and
the message exists only in CloudWatch. systemd restarts the worker every five seconds, and each
restart re-issues a `GetSecretValue` for every configured secret.

This is the failure shape #198 fixed for a bad deployment name. `github-app-auth.ts` already
defers key normalisation and `createAppAuth` into `start()` to avoid it, but the `getSecret`
that feeds them is not deferred. So the likeliest App misconfiguration — a
`GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD` that does not match the document, or a bare PEM with
a field configured — gets none of that protection.

A token AccessDenied at boot already behaved this way before the epic. #320 (JSON fields) and
#329 (the App key) added new ways to reach it: "not valid JSON", "no field", a non-string field,
and AccessDenied on the new ARN.

## Options

- Move the boot reads into a provider that `CmsWorker` calls inside `start()`'s try, so a throw
  is recorded like any other startup failure.
- Or have `main().catch` write `lastFatalError` itself. That would add a second writer of
  `worker-status.json`, which `docs/concurrency.md` should be consulted on first.
