# [P3] `refreshAuthCache` hand-rolls its error message, skipping both `getErrorMessage()` and `redactCredentials()`

Spotted 2026-09-12 while planning adopter requests #45/#46, in the course of confirming
that this method swallows errors (it does — which is why the reactive secret re-read for
those requests has to live in the adopter's callback instead).

## The gap

`packages/canopycms/src/worker/cms-worker.ts:814-825`:

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  workerLogError('Failed to refresh auth cache:', message)
}
```

Two deviations from the surrounding file, both one-line fixes:

1. **It does not use `getErrorMessage()`**, which `CLAUDE.md` mandates repo-wide. That
   helper is already imported at `cms-worker.ts:14` and used at six other sites in this
   same file (`:335`, `:344`, `:424`, `:570`, `:626`, `:658`) — so this is a genuine
   one-off, not a module that never adopted the convention.
2. **It does not pass the message through `redactCredentials()`**, unlike `:335` and
   `:658`, which wrap `getErrorMessage(err)` in it.

## Why the redaction half is the one that matters

The callback this wraps is adopter-supplied. On AWS it is `refreshClerkCache`, which
builds a Clerk client from the **secret key** — so a client-library error that echoes its
configuration is the plausible leak path, and `redactCredentials`
(`packages/canopycms/src/utils/error.ts:112-124`) would not currently see it.

Bounded today: this particular message goes to `workerLogError` and therefore to
`/var/log/canopy-worker/worker.log` and CloudWatch, **not** to `worker-status.json` or a
task file, so it is not served to a browser the way `task.error` is. That is what makes
this P3 rather than higher — but the containment is incidental, not designed, and the
fix is two lines.

## Note for whoever picks it up

Check whether `redactCredentials` has grown a PEM rule and a bare-JWT rule by then. As of
2026-09-12 it matched only URL userinfo, `gh[pousr]_`/`github_pat_` prefixes, and
`Bearer …`; adopter request #45's GitHub App work is expected to add the first two. A
Clerk `sk_live_…` key matches **none** of those rules today, so redacting here is
necessary but not by itself sufficient — the rule set needs a Clerk-shaped entry too.
