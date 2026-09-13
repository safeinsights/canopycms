# [P3] The scaffolded CDK app's type-check is not run against published packages, and two project tsconfig shapes fail it

**Priority:** P3. Neither lets a type error deploy, and neither affects a create-next-app project.
**Found:** 2026-09-13, by the review rounds of PR #332 (`fix/scaffold-cdk-typecheck`), which added
the scaffolded `infrastructure/tsconfig.json` and the deploy workflow's
`tsc --noEmit -p infrastructure` step.

## 1. CI checks the templates against workspace sources only

`packages/canopycms-cdk/src/scaffold-synth.test.ts` runs the generated type-check in a scaffold
inside that package. There `canopycms` and `canopycms-cdk` resolve to their `src/*.ts` through the
workspace `exports` field. An adopter's install resolves them to `dist/*.d.ts` through
`publishConfig.exports`, behind `skipLibCheck`. So:

- a type that is right in `src/` but missing or wrong in the published `.d.ts` passes CI;
- an error in `packages/canopycms/src` that no adopter compiles can fail the test.

PR #332 checked the published shape once, by hand: `pnpm pack` tarballs npm-installed with
aws-cdk-lib, in a CommonJS and an ES-module package. Nothing repeats that.
`scripts/smoke/standalone-image.mjs` already scaffolds from packed tarballs, but it does not install
the CDK dependencies, and `init.integration.test.ts` does not pack.

Options: install the CDK dependencies in the standalone-image smoke fixture and run the workflow's
type-check command there, or add a tarball-based test to `canopycms-cdk`.

## 2. Two project tsconfig options fail the type-check on code tsx runs

Measured by PR #332's sweep of 33 options on a scaffold:

- a `typeRoots` that leaves out `node_modules/@types`: the template's `types: ["node"]` fails with
  TS2688;
- a `rootDir` narrower than the project, such as `./app`: the CDK app's files fail with TS6059.

Both fail loudly at the workflow's type-check, and create-next-app sets neither. The template resets
four other inherited options for the same reason (see `cdk-tsconfig.json.template`). These two were
left alone because an override has to name a value, and the right value depends on the project's
layout (a monorepo hoists `@types`, for one).

Decide: override them in the template with values that fit the common layouts, or document them in
`docs/deploying-to-aws.md`.
