# [P3] `refreshAuthCache` hand-rolls its error message, skipping both `getErrorMessage()` and `redactCredentials()`

`packages/canopycms/src/worker/cms-worker.ts:978-981`:

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  workerLogError('Failed to refresh auth cache:', message)
}
```

Two one-line deviations from the surrounding file:

1. It does not use `getErrorMessage()`, which `CLAUDE.md` mandates repo-wide and which this file
   already imports and uses elsewhere. The worker loop's catch also hand-rolls an `instanceof Error`
   check inline (with the raw `err` as its fallback).
2. It does not pass the message through `redactCredentials()` (`utils/error.ts`), unlike the other
   worker log sites that wrap `getErrorMessage(err)` in it.

## Why the redaction half matters

The callback this wraps is adopter-supplied. On AWS it is `refreshClerkCache`, which builds a Clerk
client from the **secret key**, so a client-library error that echoes its configuration is the
plausible leak path. Bounded today: this message goes to `workerLogError`, so to
`/var/log/canopy-worker/worker.log` and CloudWatch, not to `worker-status.json` or a task file served
to a browser. The containment is incidental, not designed.

`redactCredentials` has rules for URL userinfo, `gh*_`/`github_pat_` tokens, `Bearer` values, PEM
private-key blocks and bare JWTs. A Clerk `sk_live_…` key matches none of them, so redacting here is
necessary but not sufficient: add a Clerk-shaped rule too.
