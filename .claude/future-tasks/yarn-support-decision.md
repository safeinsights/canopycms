# [P3] Keep or drop Yarn in `init-deploy aws`

**Priority:** P3 — no current adopter uses Yarn; the cost is a path that looks supported and is not
tested
**Split out:** 2026-09-12, from
[deploy-image-build-smoke-test.md](resolved/deploy-image-build-smoke-test.md), when its CI job
shipped for npm and pnpm only.

## What is true today

- `init-deploy aws` detects Yarn classic and Berry (`cli/project-detect.ts`) and writes install and
  build lines for both into `Dockerfile.cms` and `.github/workflows/deploy-cms.yml`.
- It then warns that those lines are a best effort and not exercised by CanopyCMS tests
  (`initDeployAws` in `cli/init.ts`). For Berry it adds that PnP is incompatible with the Next.js
  standalone output the image's runner stage copies, so `nodeLinker: node-modules` is required.
- The `standalone-image` CI job (`scripts/smoke/standalone-image.mjs`) builds and boots the
  generated image for npm and pnpm. Nothing builds it for Yarn.

## Decide

- **Drop Yarn.** `init-deploy aws` stops with "use npm or pnpm" when it detects Yarn, and both Yarn
  entries in `project-detect.ts`'s `COMMANDS` go, with their tests.
- **Support it.** Teach the smoke script `--pm yarn` (classic, and Berry with
  `nodeLinker: node-modules`), and add those legs to the `standalone-image` matrix.

Both current adopters use pnpm, and none has asked for Yarn.
