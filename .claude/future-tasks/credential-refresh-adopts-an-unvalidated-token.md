# [P3] A credential re-read adopts whatever the secret store holds, including a broken token, and never goes back

Found 2026-09-13 by review round 1 of the worker-credential epic (the worker-runtime reviewer),
from the code.

## What happens

`resolveWorkerGitHubAuth`'s `refreshCredential` (`packages/canopycms/src/worker/github-auth.ts`)
swaps in any non-empty value the provider returns, without checking that it works. Since #338 it
is called after every failed task as well as every failed sync, and neither call site is gated on
the failure being about the credential.

The scenario:

1. An operator follows `docs/deploying-to-aws.md#rotating-a-secret` and stores the new token
   before revoking the old one — but the stored value is mistyped or under-scoped, and the old
   token still works.
2. Any unrelated failure (a diverged branch's `PermanentTaskError`, a 422, a malformed payload)
   triggers a re-read. The value differs, so it is swapped in.
3. Every push now fails. Each later re-read returns `undefined`, because the value is unchanged,
   so the worker never swaps the working token back.

Before #334 the boot token survived until the instance was replaced. Recovery is fixing the
stored value, so the damage is bounded, but a working deployment is broken by a typo it was not
yet using.

## Options

- Validate before swapping: one cheap authenticated call with the new token, keeping the old
  token on failure. This adds network traffic to every refresh that finds a changed value, which
  is rare.
- Keep the previous token as a fallback, and revert when the first operation on the new one fails
  with a credential-shaped error. There is no reliable credential-shaped signal for git (see the
  status-less push error in `isPermanentTaskFailure`), which is why this is harder than it looks.
- At minimum, tell operators in the rotation docs to check the new token before storing it.
