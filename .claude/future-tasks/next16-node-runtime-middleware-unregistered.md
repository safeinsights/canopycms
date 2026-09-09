# [P2] Node-runtime middleware does not register on Next 16.1.7

Measured 2026-09-09 across two sessions while investigating an unrelated Clerk
question. Filed separately because **this is not Clerk-specific** — it
constrains any adopter who needs a Node-only module in middleware, and
`canopycms-next`'s peer range admits 16.x.

## The finding

A middleware declaring `export const config = { runtime: 'nodejs' }`:

| Next | bundler | `functions['/_middleware']` | `middleware.js` | edge registration |
| --- | --- | --- | --- | --- |
| 15.5.21 | webpack | **populated** | 162 KB | empty |
| 15.5.21 | turbopack | **populated** | 234 B | empty |
| 16.1.7 | turbopack | **EMPTY** | 234 B | empty |

All three are real `next build` runs, not source reads. The 16.1.7 arm was
measured by the website adopter on their pin; the two 15.5.21 arms here, in
`apps/dual-build-fixture`.

`loadNodeMiddleware()` requires `functions['/_middleware']` in production —
verified in 16.1.7's own `dist/server/next-server.js`. So **on 16.1.7 the build
and the server disagree**: the server reads an entry the build does not write.

The declaration removes the edge registration in **all** versions (the
`middleware-manifest.middleware` column is empty everywhere). On 15.x something
replaces it; on 16.1.7 nothing does. Net effect on 16.1.7: middleware silently
stops running, with the build exiting 0.

**The bundler is exonerated.** Turbopack was the obvious suspect and is not the
cause — it populates the manifest normally on 15.5.21. The 234 B `middleware.js`
is turbopack's signature in both turbopack arms, against webpack's 162 KB, which
is what identifies the bundler as the irrelevant variable. The difference is
16.1.7 itself.

## Why it matters to us

1. **A one-line "fix" to our scaffold would ship auth-silently-off.** Our
   generated `middleware-clerk.ts.template` declares no runtime, so it runs on
   edge; adding `runtime: 'nodejs'` is the natural change and would disable
   `auth.protect()` on `/edit` and `/api/canopycms` for any 16.x adopter. Do not
   make that change without a per-version measurement. Recorded at the point of
   temptation in
   [deploy-test-lambda-plaintext-clerk-secret.md](deploy-test-lambda-plaintext-clerk-secret.md).
2. **Anything needing a Node-only module in middleware is blocked on 16.x** — an
   AWS SDK call being the motivating case, but `node:fs`, `node:crypto` and
   friends equally.

## What is NOT established

- **Why** the build stops writing the entry on 16.1.7 — regression, or a
  mechanism that moved somewhere neither session found. `routes-manifest.json`
  was checked and does not mention middleware; the only `_middleware` strings
  under `.next` were vendored Next source.
- Whether a newer 16.x patch fixes it. 16.1.7 is a pinned version, not the
  latest line.
- Any of this at **serving** time. Every arm is build output; no server was
  started.

## Fix direction

Nothing to fix in this repo — the correct action is a **guard plus a report**:

1. Keep the `do not` on the template (done).
2. If a Node-runtime middleware ever becomes load-bearing for CanopyCMS, pin
   the check per Next version rather than assuming it carries, and consider a
   build-level assertion in the dual-build fixture.
3. **Report upstream to Vercel.** A build/server disagreement that silently
   unregisters middleware is worth a Next issue with the three-arm table above;
   neither this project nor the adopter's turns on the diagnosis, so nobody
   should chase it further internally.
