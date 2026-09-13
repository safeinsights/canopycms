# [P2] `init-deploy aws` scaffold: two gaps a first real image build hits

**Priority:** P2 — both fail loudly on an adopter's first build and have a known workaround; PR 5
of the CMS image epic will hit both
**Found:** 2026-09-12, by the local Docker verification for
[cms-image-build-epic.md](cms-image-build-epic.md) PR 1. The run used a fresh Next 16.1.7 app
(pnpm 11.21.0, from `create-next-app`), `canopycms init` + `canopycms init-deploy aws` from
`pnpm pack` tarballs, then `next build` and `docker build -f Dockerfile.cms`. Neither gap is
caused by PR 1.

## 1. The generated `infrastructure/` breaks the app's own `next build` type-check

`init-deploy aws` writes `infrastructure/bin/app.ts` and the stack, which import `aws-cdk-lib`
and `canopycms-cdk`. A Next app's default `tsconfig.json` includes `**/*.ts` and does not
exclude that directory, so `next build`'s type-check fails with
`Cannot find module 'aws-cdk-lib'` unless the CDK toolchain is installed in the app itself.
That happens both in a local build and in `Dockerfile.cms`'s build step, because `COPY . .`
brings `infrastructure/` into the builder. Reproduced; worked around by adding
`"infrastructure"` to the app's `tsconfig.json` `exclude`.

Options:

- have `init-deploy aws` add the exclusion, or give `infrastructure/` its own `tsconfig.json`
  and exclude it from the app's;
- or state the step as required where the CLI's closing note currently presents the CDK
  install as optional.

Also consider adding `infrastructure/` to the generated `.dockerignore`, since the image never
uses it.

## 2. The Dockerfile's pnpm path does not carry `pnpm-workspace.yaml` into the install

pnpm 11 hard-errors (`ERR_PNPM_IGNORED_BUILDS`) on dependency build scripts that
`pnpm-workspace.yaml`'s `allowBuilds` does not approve. CanopyCMS's editor pulls in `es5-ext`
(via `@mdxeditor/editor`), whose postinstall needs approving, and `create-next-app` seeds that
block only for `sharp` and `unrs-resolver`. The generated `Dockerfile.cms` copies only
`package.json pnpm-lock.yaml` before `pnpm install --frozen-lockfile`, so an approval in
`pnpm-workspace.yaml` never reaches the builder's install.

The verification added `es5-ext: true` and copied `pnpm-workspace.yaml` in that first COPY. The
local install failure was observed; the Docker install failing without the copy was not
separately run.

The epic spec already expects PR 5 to meet this: "The pnpm fixture probably needs
`allowBuilds` … If the template's pnpm path needs it too, fix the template in this PR". This file
records the concrete package and the missing COPY.

## Verify

Scaffold as above without the workarounds. Expect `next build` to fail on `aws-cdk-lib`. With
gap 1 fixed but not gap 2, expect the image's install step to fail on `es5-ext`.
