# [P3] The unhandled-rejection test for `loadSharp()` passes without the code it guards

**Priority:** P3. A test-strength gap, not a defect: the guarded code is correct today, and the
suite still goes red without it, just not through this test.
**Found:** 2026-09-13, by the claims pass over the integration PR (#331) of
[cms-image-build-epic.md](cms-image-build-epic.md), which removed the guarded line and re-ran the
test.

## What the test is for

`loadSharp()` in `packages/canopycms/src/assets/sharp-loader.ts` memoizes its first load, rejection
included, and then calls `loading.catch(() => undefined)` on the stored promise. That marks the
promise handled, so a caller that does not await it (a warm-up `void loadSharp()`) cannot leave an
unhandled rejection, which Node treats as fatal by default.

`packages/canopycms/src/assets/transform.sharp-unavailable.test.ts` pins this with "does not leave
an un-awaited first load as an unhandled rejection". It calls `void loadSharp()`, waits one
macrotask, and asserts that exactly one error was logged. Its comment relies on vitest: one
macrotask is enough for Node to report the rejection, "which vitest turns into a failed run".

## What was observed

With `loading.catch(() => undefined)` removed from `sharp-loader.ts`, all 5 tests in that file
still pass, that one included. The run exits 1 only because vitest reports `Errors  1 error`, an
"Unhandled Rejection", outside any test.

So the test's own assertion does not observe the thing it is named for. The failure lands on no
test, and a run-level error line is easy to misread as noise.

## Direction

Make the test observe the rejection itself: for example, add a `process.on('unhandledRejection')`
listener for the test's duration and assert, after the macrotask, that it was never called. Then
remove `loading.catch` again and confirm this test, not just the run, goes red.
