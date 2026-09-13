# [P3] `executeTaskWithTimeout`'s unhandled-rejection guard is dead code, and its comment claims otherwise

Found 2026-09-12 by review round 3 on PR #321 (GitHub App auth), which flagged it as
pre-existing and out of scope for that change.

## The gap

`packages/canopycms/src/worker/task-runner.ts`, in `executeTaskWithTimeout`:

```ts
const work = ctx.executeTask(task, controller.signal)
// If the timeout wins the race, the losing promise must not surface an
// unhandled rejection when it eventually settles.
work.catch(() => {})
...
return await Promise.race([work, timedOut])
```

`Promise.race` subscribes a reject handler to **every** input, so the loser's late
rejection is already handled. Measured:

```js
let unhandled = 0
process.on('unhandledRejection', () => unhandled++)
const slow = new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 30))
const fast = new Promise((_, rej) => setTimeout(() => rej(new Error('fast')), 5))
Promise.race([slow, fast]).catch(() => {})
setTimeout(() => console.log(unhandled), 120)   // -> 0
```

So the line does nothing, and the comment above it states a mechanism that is not real.

## Why it matters at all

It is not a bug — it is a comment that will be believed. The identical pattern was
copied into `worker/github-auth.ts`'s `mintInstallationToken` on PR #321 precisely
because this one looked load-bearing, and the test written to guard it passed with the
line deleted. That copy has since been removed and replaced with a comment explaining
why there is no guard; this one is the original.

## If it is picked up

Delete `work.catch(() => {})` and rewrite the comment to say what `github-auth.ts`'s
now says: `Promise.race` handles both inputs, so no guard is needed. Confirm with the
snippet above plus a run of `packages/canopycms/src/worker/cms-worker.test.ts`, and
watch vitest's **Unhandled Errors** section specifically — it is printed separately from
the pass count, so a green summary alone does not prove it.
