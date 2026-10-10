# `cli/` — CLI

The `canopycms` commands and adopter-project scaffolding.

The **code comment at the point of the rule is authoritative**; this file is the map to
where those rules live.

## Overview

CLI commands (`init`, `init-deploy`, `init-github-app`, `worker run-once`, `generate-ai-content`, `collect-asset-refs` and `materialize-assets` in `asset-refs.ts`, `sync`, `migrate`); project-root discovery (`project-root.ts`)

`asset-refs.ts`'s `resolveStore` builds an `S3AssetStore` from `--bucket`/`--region`, else imports `configured-asset-store.ts` (jiti) and refuses a non-S3 store without `--allow-local`; `MATERIALIZE_EXIT_CODES` is the exit contract a release gates on

`cli.ts` exports `KNOWN_AUTH_MODES`/`isKnownAuthMode` (`worker run-once`'s auth-mode dispatch) and `findMultiValuedMaterializeFlag` (`materialize-assets`'s single-value flags, such as `--output-prefix`) for testing; each one's comment holds its rule

## `init-github-app.ts`

Registers the GitHub App the worker authenticates as, via GitHub's App-manifest flow.
`CANOPY_APP_PERMISSIONS` (`github-app-manifest.ts`) is the whole security surface and each entry carries the call site
that forces it; `github-app-permission-drift.test.ts` keeps it in step by driving the worker's
dispatch table against a recording `Proxy` rather than grepping (the call sites have three
spellings and one spans lines, so a textual scan passed vacuously).

Three invariants whose reasons are in the file header, not here: **one App per site** (an App's
private key is App-level, so a shared App means one site's leaked key mints writes on another
site's repository); **`fetch`, never Octokit** (an App JWT needs `Bearer`, and
`@octokit/auth-app` is a lint error in this package — so the JWT is hand-rolled over
`node:crypto`); and **the key's destination is never this tool's business** (`-- <cmd>` on
stdin, or `--key-out`; no AWS or other cloud concept in the code).

`cli.ts`'s `parseArgs` passes minimist's `'--': true` solely so this command can recover a
clean argv for `spawn`; `passthroughArgs(argv)` narrows it without an `any`.

## `project-detect.ts`

Best-effort project detection for `init-deploy aws`, which scaffolds a CDK app (`cdk.json`, `infrastructure/bin/app.ts`, `infrastructure/lib/cms-stack.ts`, `infrastructure/tsconfig.json`) via `templates.ts`. `aws-deploy-example.ts` renders `examples/aws-deployment/` through the same functions; `pnpm generate:aws-example` writes it, and its test fails on drift.
