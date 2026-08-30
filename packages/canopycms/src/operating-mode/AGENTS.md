# `operating-mode/` — Operating modes

The prod/dev strategies, and the single resolution points for mode and deployment name.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
117 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

Operating mode strategies (prod, dev)

`deployment-name.ts`'s `resolveDeploymentName()` is the single resolution point for `deploymentName` (env `CANOPYCMS_DEPLOYMENT_NAME` > `config.deploymentName` > mode default), used by both strategies' `getSettingsBranchName()` so every settings-branch-name computation agrees

`deployment-name-fixtures.ts` is the shared valid/invalid list both this package's suite and `canopycms-cdk`'s assert against, so the construct's duplicated copy of that rule goes red on drift instead of relying on a comment

`mode-env.ts`'s `resolveOperatingMode()` is the single resolution point for `mode` (env > `config.mode`), applied inside `validateCanopyConfig` — server code reads `CANOPY_MODE` at run time (stamped on the Lambda by `CanopyCmsService`) while browser code reads the build-inlined `NEXT_PUBLIC_CANOPY_MODE`, which is what lets one `canopycms.config.ts` say `dev` for `next dev`/`next build` and still deploy a prod-mode Lambda
