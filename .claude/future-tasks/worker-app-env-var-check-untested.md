# [P3] The worker entrypoint's all-or-nothing GitHub App env-var check is untested

Filed 2026-09-13 while landing PR #334 (reactive secret re-read). Noticed rather than
caused by that PR, and deliberately not fixed in it — the fix is an `index.ts`
restructure, which is a wider change than a secret-handling PR should carry.

## The gap

`packages/canopycms-cdk/worker/index.ts` reads the three GitHub App variables as a group
and rejects a partial set:

```ts
const githubAppMissing = githubAppVars.filter(([, value]) => !value).map(([name]) => name)
if (githubAppMissing.length > 0 && githubAppMissing.length < githubAppVars.length) {
  throw new Error(`GitHub App authentication needs all of ...`)
}
```

**Nothing exercises it.** `index.ts` ends in `main().catch(...)`, so importing it runs the
worker — which is exactly why `secrets.ts`, `github-app-auth.ts` and (as of #334)
`credential-refresh.ts` and `clerk-refresh.ts` were each split out into their own module.
`main()` itself is not exported and has no test.

The synth-time twin of this check, `assertGitHubAuthProps` in
`src/constructs/cms-service.ts`, **is** tested. That is why this matters less than it
might: the construct is the normal way these variables arrive. The entrypoint check exists
for the case the construct does not cover — an operator setting the instance's environment
directly — and that is the case with no coverage at all.

## What would close it

Extract the check into its own function (`resolveGitHubAppCredentials(env)` or similar,
beside `github-app-auth.ts`) and test it: all three set, none set, and each of the three
single-missing permutations. The current shape is one expression, so this is a small move.

Worth doing at the same time: `main()` is now almost entirely env reads and wiring, so the
same extraction could leave it with nothing untested in it at all.

## Why it is P3

- The synth-time check catches this for every deployment that uses the CDK construct.
- The failure mode is a loud throw with a good message, at boot, not a silent wrong result.
- The message itself has been read by a human; what is unverified is that the *condition*
  fires on exactly the five partial permutations.

Related: [refresh-auth-cache-error-handling.md](refresh-auth-cache-error-handling.md) and
[github-service-static-token-only.md](github-service-static-token-only.md), both filed from
the same planning pass over adopter requests #45/#46.
