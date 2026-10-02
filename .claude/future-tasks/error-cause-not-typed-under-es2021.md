# [P3] `Error.cause` is untyped repo-wide, so every reader of it needs a cast

Found 2026-09-12 while landing GitHub App auth (PR #321). Worked around there; filed
rather than fixed, because the honest fix is repo-wide and a feature PR is the wrong
place for it.

## The gap

`tsconfig.base.json` sets `target: "ES2021"` and no `lib` override, so TypeScript's
`Error` type has no `cause` property. Reading it is a compile error:

```
error TS2550: Property 'cause' does not exist on type 'Error'.
  Do you need to change your target library? Try changing the 'lib' compiler option to 'es2022' or later.
```

Every supported runtime has it — `package.json` requires `node >= 22.12.0`, and
`Error.cause` landed in Node 16.9. Only the type surface is behind.

## Where it bites today

`networkErrorCode` in `packages/canopycms/src/worker/github-auth.ts` has to read the
errno one level down in `cause`, because a `fetch()` DNS failure is
`TypeError: fetch failed` whose own `.code` is `undefined` and whose `.cause.code` is
`ENOTFOUND` (measured on Node 24). It reads through
`(err as { cause?: unknown }).cause` and says why in a comment. The two tests for it
build their errors with `Object.assign(new Error(...), { cause })` for the same reason.

That is three casts to express something the language has had for four years, and the
next person to reach for `cause` will hit the same wall and either add a fourth or,
worse, decide the pattern is unidiomatic and drop the `cause` walk.

## If it is picked up

Add `"lib": ["ES2022"]` (plus whatever DOM libs each package already needs) to
`tsconfig.base.json`, or raise `target` to `ES2022`. Raising `lib` alone is the smaller
change: it only widens the type surface and emits nothing different.

**Verify against every package**, not just `canopycms` — `pnpm typecheck` runs eight
projects including `canopycms-cdk`'s four extra tsconfigs (`lambda`, `canary`, `worker`,
`test-support`). Then remove the cast and the comment in `github-auth.ts`, and simplify
the two tests to plain `err.cause = ...` assignment.

**And check the exit status, not the output.** The typecheck failure above shipped into
a PR body as "clean" because the check was piped through `grep | head -3` and the
sandbox's certificate-warning lines filled all three slots.
