---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-09-12, spotted while confirming that `CmsWorker.refreshAuthCache()` swallows errors (it does — which is why adopter request #45/#46's reactive secret re-read has to live in the adopter callback instead). Its catch at `cms-worker.ts:1084-1085` hand-rolls `err instanceof Error ? err.message : 'Unknown error'` rather than the `getErrorMessage()` CLAUDE.md mandates — the worker loop's catch at `:510` hand-rolls a similar but not identical check (`err instanceof Error ? err.message : err`) — while that helper is imported at `:20` and used at eight other sites in the same file — and skips `redactCredentials()`, unlike `:380`, `:707`, `:868` and `:1047`. The redaction half is the one that matters: the wrapped callback is adopter-supplied and on AWS builds a Clerk client from the **secret key**. Bounded today only incidentally (this message reaches the log and CloudWatch, not `worker-status.json` or a task file, so it is never served to a browser). Note a Clerk `sk_live_…` matches none of `redactCredentials`'s current rules, so redacting here is necessary but not sufficient
---
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
