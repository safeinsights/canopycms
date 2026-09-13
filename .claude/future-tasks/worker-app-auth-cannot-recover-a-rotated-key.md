# [P2] Under GitHub App auth, a rotated private key or an early-revoked installation token is never recovered without a restart

Found 2026-09-13 by review round 1 of the worker-credential epic (the worker-runtime
reviewer), from the code and the installed `@octokit/auth-app@6.1.4` source. Not fixed in the
review: closing it needs a new injection seam, which is design work.

## Key rotation (MEDIUM)

The worker reads the App private key once, in `main()`
(`packages/canopycms-cdk/worker/index.ts`), and builds one memoized `createAppAuth` closure
over it (`packages/canopycms-cdk/worker/github-app-auth.ts`). On the App path
`refreshCredential` is deliberately a no-op (`resolveWorkerGitHubAuth` in
`packages/canopycms/src/worker/github-auth.ts`), so neither trigger — a failed sync or a failed
task — ever loads a new key.

When an operator rotates the way GitHub documents it — generate a new key, store it, delete the
old one — **without** replacing the instance:

1. **Nothing fails for up to an hour.** The reviewer read `@octokit/auth-app`'s
   `dist-src/cache.js`: installation tokens are cached in an LRU with a 59-minute TTL, and a
   cached token does not stop working when the key that minted it is deleted.
2. **Then every mint fails.** When the cached token expires, the next mint signs its JWT with
   the deleted key and GitHub answers 401. The `RequestError` propagates as thrown, and
   `isPermanentTaskFailure` reads a 401 as permanent.
3. **Every publish then fails fast.** Each push task fails with no retry and marks its branch
   `sync-failed`, with a reason that does not name the key. The sync loop fails every five
   minutes, and the new key sitting in Secrets Manager is never read.

Recovery takes an instance replacement plus a manual requeue of every branch that failed in the
meantime. `docs/deploying-to-aws.md#rotating-a-secret` does say an App key needs an instance
replacement, but not that the instance must be replaced **before** the old key is deleted — the
order that avoids all of this.

## An installation token revoked early (LOW, plausible)

`mintInstallationToken` in `packages/canopycms-cdk/worker/github-app-auth.ts` never passes
`refresh: true`. Per the reviewer's reading of `hook.js`, the strategy retries a 401 only within
5 seconds of the token's creation. So a token revoked early while the App itself is healthy
(`DELETE /installation/token`, or GitHub revoking a leaked `ghs_`) is served from the cache for
up to 59 minutes, although a fresh mint would work immediately. Which events actually revoke a
token early is not confirmed.

## Options

1. **Docs.** State the order: store the new key, replace the instance, then delete the old key.
   Cheap, and worth doing whichever of the options below is chosen.
2. **A re-read seam for the App path.** On a failure, re-read the key secret, with the same floor
   and unchanged-value guard as the PAT, and rebuild the `createAppAuth` instance when the key
   changed. Core would have to swap `octokitAuth` and `mintInstallationToken` together.
   `worker-context.ts`'s INVARIANT and the Octokit that `ensureGitHubAuth()` memoizes both bear on
   how.
3. **Force a re-mint (`refresh: true`) on a failure, behind a floor.** This covers the
   early-revocation case but not key rotation.

Verify live as part of
[github-app-auth-unexercised-against-real-github.md](github-app-auth-unexercised-against-real-github.md).
