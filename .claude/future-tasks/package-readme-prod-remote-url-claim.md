---
priority: P3
adopters: BOTH
summary: >-
  `packages/canopycms/README.md` tells prod adopters `defaultRemoteUrl` is required (lines 49, 109 and 497, one with an https example), but prod's `validateConfig` does not require it and refuses a network URL without `allowNetworkRemoteInProd`; the Lambda auto-detects `{workspace}/remote.git`. Following the README breaks a standard AWS deploy
---
# The package README says prod requires `defaultRemoteUrl`

## Priority: P3

Found by the review of the prod base-branch detection work (fix/prod-default-branch-detection).

## Problem

`packages/canopycms/README.md` says three times that prod mode needs `defaultRemoteUrl`:

- line 49: "For `prod` mode, you must set `defaultRemoteUrl`."
- line 109: a config example comment, "For prod mode, defaultRemoteUrl is required."
- line 497: "**`prod`**: … Requires `defaultRemoteUrl`."

None of that holds for the supported AWS topology. `ProdStrategy.validateConfig`
(`operating-mode/client-unsafe-strategy.ts`) checks only the bot identity, and
`GitManager.resolveRemoteUrl` auto-detects `{workspace}/remote.git`, which the worker creates. A
network URL there is refused unless `allowNetworkRemoteInProd` is set
(`assertRemoteUrlAllowedInMode`). With `defaultBaseBranch` unset, a network URL also fails service
creation, because the base branch cannot be read from it locally (`GitManager.detectBaseBranch`).

## Fix sketch

Replace the three statements with the actual rule: prod auto-detects the worker's `remote.git`, and
`defaultRemoteUrl` is for a non-standard deployment (a local path, or a network URL with
`allowNetworkRemoteInProd`). Cross-check the root README and `docs/deploying-to-aws.md` for the
same claim.
