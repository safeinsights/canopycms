# `operating-mode/` — Operating modes

The **code comment at the point of the rule is authoritative**; this file is only the
map to where those rules live.

- `mode-env.ts` — `resolveOperatingMode()`, the single resolution point for `mode`,
  applied inside `validateCanopyConfig`. Its header covers precedence and the two
  environment variable names.
- `deployment-name.ts` — `resolveDeploymentName()`, the single resolution point for
  `deploymentName`, used by both strategies' `getSettingsBranchName()`.
- `deployment-name-fixtures.ts` — the shared valid/invalid list this package's suite
  and `canopycms-cdk`'s both assert against, so the construct's duplicated copy of
  that rule goes red on drift.
- `client-safe-strategy.ts` / `client-unsafe-strategy.ts` — the split that keeps
  Node.js out of client bundles.
