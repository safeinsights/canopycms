# [P3] `withOccFileLock`'s compromise handler is still silent in production

**Found:** 2026-08-20, by the independent review of `fix/test-suite-unhandled-errors`
(the branch that fixed [proper-lockfile-hazards](resolved/proper-lockfile-hazards.md)).

## Problem

`utils/occ-json-write.ts`'s `withOccFileLock` passes an `onCompromised` that logs via
`createDebugLogger`:

```ts
onCompromised: (err) => {
  log.warn('lock', `Lock compromised mid-hold for ${filePath}`, { ... })
}
```

`createDebugLogger`'s `warn` is gated on `CANOPYCMS_DEBUG === 'true'`
(`utils/debug.ts`'s `shouldLog`), so in production this emits **nothing**.

## Why it matters

This is not a cosmetic logging preference. A compromised lock means *two holders may now
be live* — on EFS, the realistic trigger is a waiter reading a cached mtime, judging a
live holder stale, and taking the lock over. That is precisely the event you want in
CloudWatch when reconciling a lost update to `branch.json` or `comments.json` after the
fact, and today there is no record it happened.

`provisioning-lock.ts` was moved to always-on `canopyLogWarn` for exactly this reason on
2026-08-20, which leaves the two lock layers inconsistent: layer 3's provisioning half
reports compromises in prod, its OCC half does not.

## Fix direction

Switch to `canopyLogWarn`/`canopyLogError` from `utils/logger.ts` (worker-aware via
`setCanopyLogger`, so it keeps the CloudWatch timestamp prefix the agent's
`multi_line_start_pattern` keys on).

One wrinkle to handle deliberately rather than trip over: `vitest.config.ts`'s
`onConsoleLog` throws on any console write when `CI` is set, so a test that provokes an
OCC compromise would hard-fail CI rather than warn. Wrap such a test with `mockConsole()`
from `src/test-utils/console-spy.ts` and assert the warning, as
`utils/provisioning-lock.test.ts` does. Note `provisioning-lock.ts` also wraps the handler
in a `try/catch` so a throwing logger cannot kill the process; the OCC handler should get
the same treatment.

## Not urgent because

Nothing is broken today — the handler already prevents the process-killing rethrow, which
was the dangerous half. This is purely about observability in prod. [BOTH]
