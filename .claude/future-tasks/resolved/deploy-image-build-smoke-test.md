# No test ever builds the CMS Docker image

Filed 2026-08-12, from `fix/deploy-template-cdk-app` (the CDK-app scaffolding
fix). Not a regression that branch introduced — it made an existing blind spot
larger and worth naming.

**RESOLVED 2026-09-12** by PR 5 of [cms-image-build-epic.md](../cms-image-build-epic.md), branch
`ci/standalone-image-smoke`. The `standalone-image` job in `.github/workflows/ci.yml` runs
`scripts/smoke/standalone-image.mjs` for pnpm and npm on `ubuntu-latest` and for pnpm on
`ubuntu-24.04-arm`, path-gated like `dual-build`. The script scaffolds a Next 16.1.7 app outside
the workspace from `pnpm pack` tarballs, runs `init` and `init-deploy aws`, and builds the
generated `Dockerfile.cms`. Its only edit to that file is the vendored-tarball COPY the file's own
comment asks for. It then boots the image and checks:

- build-time and request-time content reads on a non-`main` base branch;
- not-found responses;
- an upload, its finalize, and a transform;
- that the externalized sharp loads its own libvips.

The Yarn question below moved to [yarn-support-decision.md](../yarn-support-decision.md). The
job's first build found three scaffold defects, fixed in the same PR; see
[init-deploy-aws-first-build-gaps.md](init-deploy-aws-first-build-gaps.md).

## What is unverified

`Dockerfile.cms.template` is the image `cdk deploy` builds and the Lambda runs.
Nothing in CI builds it. Every assertion about it — in `init.test.ts` and in
`packages/canopycms-cdk/src/scaffold-synth.test.ts` — is either a string match
on the generated text or a synth that stops at *staging* the build context.
CDK's `fromImageAsset` hashes and copies the directory at synth time; `docker
build` does not run until asset publishing, which only a real deploy reaches.

That blind spot now covers more ground, because the install and build lines are
written per package manager:

| Path | Exercised by |
| --- | --- |
| npm (`npm ci`, `npm run build`) | the 2026-07 deployment-test epic, on a real deploy |
| pnpm (`corepack enable && pnpm install --frozen-lockfile`) | **nothing** |
| Yarn classic / Berry | **nothing** (and `init-deploy aws` warns as much) |

pnpm is the one that matters: `docs-site-proto` is a pnpm project, so it is the
variant the first real adopter will hit. Next.js standalone output does support
pnpm's symlinked layout, but "supported upstream" is not the same as "we built
this Dockerfile and it worked".

## Fix direction

A CI job that builds the generated image for at least npm and pnpm and asserts
the container starts. Cheapest useful shape:

1. Scaffold a minimal Next app with `canopycms init` + `init-deploy aws` into a
   temp dir, once per package manager.
2. `docker build -f Dockerfile.cms .`
3. Run the image and assert `server.js` boots and answers a request.

Gate it behind a `paths:` filter on `Dockerfile.cms.template` and the CLI
templates — it is far too slow for every PR, and the dual-build job in `ci.yml`
already establishes that pattern.

Worth pairing with a decision on whether to keep Yarn support at all: it is
templated but untested, and Berry's PnP linker is incompatible with the
standalone output the runner stage copies. Dropping it to a clear "use npm or
pnpm" would be more honest than a warned-but-shipped path, if no adopter wants
it.
