# Deploying CanopyCMS to AWS

This guide walks through deploying CanopyCMS on AWS using Lambda + EFS + EC2 Worker. This architecture costs ~$5-9/month and is designed for low-traffic CMS editing workflows.

> **Deploy-proven notes (2026-07).** The whole stack was first deployed and
> exercised end-to-end during the deployment-test epic — see
> [`.claude/future-tasks/resolved/cms-service-deployment-test.md`](../.claude/future-tasks/resolved/cms-service-deployment-test.md)
> for the full account of what broke and the fixes. Load-bearing gotchas that
> guide is the source of truth for: reference secrets by their **full** ARN
> (below); the CMS image's **build platform must match the Lambda
> architecture** (for a `fromImageAsset` image CDK now derives it from
> `CanopyCmsService`'s architecture, arm64 by default — see
> [Where the image is built](#where-the-image-is-built));
> **`clerkMiddleware` needs an explicit `jwtKey`** (the env var alone is never
> read → the no-internet Lambda hangs on sign-in) and a secret key, if you keep
> it — it is optional, see [Dual Build Support](#dual-build-support); the raw-CloudFront path needs the managed
> `CACHING_DISABLED` policy and an `x-forwarded-host`-only CloudFront Function;
> and a two-pass deploy for bucket CORS + `CLERK_AUTHORIZED_PARTIES`. The
> EC2 worker's logs now ship to CloudWatch by default (see
> [Worker observability](#worker-observability) below) — a locked-down
> operator role may not have SSM, and the worker was otherwise unobservable.
> Adopters consume the published `canopycms-cdk` package; the constructs
> referenced here also power `AssetSupport` for media (pass it to
> `CanopyCmsDistribution`'s `assetSupport` prop to give the deployed editor an
> upload/transform backend, with both CloudFront behaviors wired in the only
> order that is safe).

## Architecture Overview

```
Editor browser
    │
    ▼
CloudFront (cms.docs.example.org)
    │
    ▼
Lambda (VPC, no internet)               EC2 Worker (t4g.nano spot)
    │                                        │
    ├── JWT verification (networkless)       ├── git push/pull ↔ GitHub
    ├── User metadata (EFS cache)            ├── GitHub API (PRs)
    ├── Git ops (local file:// URL)          ├── Refresh auth cache → EFS
    ├── Content read/write (EFS)             ├── Rebase branches
    └── Queue async tasks → EFS              └── Process task queue
            │                                        │
            └────────── EFS (shared) ────────────────┘
```

**Why this architecture?**

- **No NAT Gateway** — Lambda has no internet access, saving ~$32/month
- **Secrets stay on the worker** — Lambda only has public keys and config. The worker
  does not leave the GitHub bot token on the shared filesystem: `remote.git` is
  cloned under a staging name and renamed into place only after the token-bearing
  `remote.origin.url` is removed and verified gone, and an existing `remote.git` is
  re-checked (and scrubbed) on every worker start, so a token left by an older build
  self-heals. Stated precisely, this is a bounded window rather than "never": the
  initial bare clone does write the token into the _staging_ copy's config until the
  scrub runs moments later, and a crash in that gap leaves it there until the next
  worker boot deletes the staging directory. What is eliminated is unbounded
  persistence under the real `remote.git` name. Closing the window entirely needs a
  credential helper instead of a token-bearing clone URL
- **Same app, two builds** — The adopter's Next.js app builds as both a static export (public site) and a standalone server (CMS Lambda)
- **Preview works** — The CMS Lambda renders the same React components as the public site, so the editor's preview iframe shows accurate previews

## Prerequisites

- AWS account with CDK bootstrapped
- GitHub repo with your site content
- Clerk account (or plan to use dev auth for testing)
- Node.js 22.12+ (the published packages' `engines` floor)
- A `next` version within `canopycms-next`'s peer dependency range (see [README Requirements](../README.md#requirements)) — in particular, avoid `16.2.x`: it fork-bombs `next dev --turbopack` on any app that imports CSS (including the CanopyCMS editor's Mantine styles), which you'll hit locally before you ever get to Step 3

## Step 1: Add CanopyCMS to Your App

Run the bootstrapping script in your Next.js app:

```bash
npx canopycms init
```

This creates:

- `canopycms.config.ts` — CanopyCMS configuration
- `app/lib/canopy.ts` — Server-side context (auth plugin selection)
- `app/schemas.ts` — Entry schema definitions (customize for your content)
- `app/api/canopycms/[...canopycms]/route.ts` — Catch-all API handler
- `app/edit/page.tsx` — Editor page

**Customize `app/schemas.ts`** to match your content structure. Each collection's `.collection.json` file references an entry schema by name.

### Dual Build Support

Your `next.config.ts` needs to support two build modes:

```typescript
import { withCanopy } from 'canopycms-next/config'

export default withCanopy({
  output: process.env.CANOPY_BUILD === 'cms' ? 'standalone' : 'export',
})
```

- `npm run build` → static export for S3 (public site)
- `CANOPY_BUILD=cms npm run build` → standalone server for Lambda (CMS)

**sharp in the standalone image.** For the CMS build, `withCanopy()` also adds sharp's libvips shared library to Next's file tracing. Next can miss that library for sharp 0.35 ([vercel/next.js#97973](https://github.com/vercel/next.js/issues/97973)). An image built without it fails to load sharp at runtime with `ERR_DLOPEN_FAILED`. The include fixes Turbopack builds, Next 16's default. It does not fix a webpack build (Next 13 to 15, or `next build --webpack`): on Next 15.5.21 with pnpm, Next bundles sharp's JavaScript into a server chunk, so image transforms fail with or without the include. Other Next versions, Next 16's `--webpack` and npm installs have not been checked ([webpack-standalone-sharp-bundled.md](../.claude/future-tasks/webpack-standalone-sharp-bundled.md)).

If you don't use `withCanopy()`, or your standalone build prints `CanopyCMS: could not add sharp's libvips…`, add the directory yourself. Paths are relative to the Next.js project directory. With pnpm:

```typescript
export default {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/**': ['node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/**/*'],
  },
}
```

- **npm.** npm's hoisted layout puts the same directory at `node_modules/@img/sharp-libvips-*/lib`.
- **Monorepo.** Prefix the glob with the path from the app to the directory that holds `node_modules`, e.g. `../../`. That directory must be inside Next's tracing root: `outputFileTracingRoot`, or the lockfile directory Next infers.
- **Next 13 or 14.** Nest `outputFileTracingIncludes` under `experimental`. These versions build with webpack, so read the note above first.

For a content route shared by both builds (e.g. `app/[slug]/`, or a fixed page like the home route), don't use a single `page.tsx`: `output: 'export'` requires `dynamicParams = false`, but on the CMS Lambda that makes an unknown slug throw Next's internal `NoFallbackError` (a 500) before your page's `notFound()` runs — and Next statically parses route-segment config, so the value can't be a conditional expression. The CMS build also must not prerender content pages: a build-time prerender serves build-time content to anonymous visitors (bypassing runtime path ACLs), and rendering a not-prerendered slug as on-demand static generation makes the request-scoped read throw `DYNAMIC_SERVER_USAGE` (also a 500). Split the page instead:

```tsx
// app/[slug]/slug-page.tsx — shared implementation
// app/[slug]/page.static.tsx — static export build:
//   re-exports default + generateStaticParams, plus `dynamicParams = false`
// app/[slug]/page.server.tsx — CMS build: re-exports default only,
//   plus `export const dynamic = 'force-dynamic'` (no generateStaticParams)
```

`withCanopy(nextConfig, { staticBuild })` picks the matching variant per build (see [README Dual-Build Sites](../README.md#dual-build-sites-static-export--cms-server) for the full example).

Anonymous/public read on the CMS Lambda also needs `defaultPathAccess: { read: 'allow' }` in `canopycms.config.ts` (see [README Permission Model](../README.md#permission-model)); without it, forbidden reads render a 404 instead of a 500, but genuinely public content still needs the explicit allow.

**Where a Clerk (or any auth SDK) provider goes.** A dual-build adopter cannot mount `<ClerkProvider>` in the app's root layout: the root layout is shared by both builds, so merely importing `@clerk/nextjs` there reaches the static export too — and in practice this is worse than dead code shipping to public visitors, because `ClerkProvider` pulls in React Server Actions internally, which `output: 'export'` rejects outright (`next build` fails with "Server Actions are not supported with static export"). Put the provider in a layout scoped to the editor subtree instead, named under the CMS-only extension, e.g. `app/edit/layout.server.tsx`. This works because `withCanopy()`'s `pageExtensions` handling is **additive, not subtractive**: `staticBuild: true` adds `static.ts`/`static.tsx` to `pageExtensions` _instead of_ `server.ts`/`server.tsx` — nothing is removed from a shared list, the two build flavors just add different extensions on top of Next's defaults. Next's app-dir loader resolves every special file (`layout`, `page`, `route`, `loading`, `error`, …) through that same `pageExtensions`-derived resolver, with no special case for `layout` — so a `layout.server.tsx` is picked up as a real layout, scoped to its subtree, exactly like `page.server.tsx` is picked up as a page, whenever `server.tsx` is present, and is invisible whenever it isn't. `apps/dual-build-fixture` enforces both halves of this in CI (`dual-build.test.ts`): the CMS build's compiled `/edit` output must reference `@clerk/nextjs`, and the static build's output must not contain a single byte of it — so this is a guarantee the build enforces, not just advice you have to trust.

**One image for every Clerk tier.** `<ClerkProvider>` takes an explicit `publishableKey` prop, and `@clerk/nextjs` prefers it over `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, so the editor layout can read the key from a plain run-time variable instead of baking it into the image:

```tsx
// app/edit/layout.server.tsx
import { ClerkProvider } from '@clerk/nextjs'

// Render per request. Without this, Next prerenders /edit at `next build`
// and bakes in whatever the variable held then.
export const dynamic = 'force-dynamic'

export default function EditLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>{children}</ClerkProvider>
  )
}
```

The `dynamic` export has to be in the layout. The scaffolded edit page is a `'use client'` module, and a `dynamic` export from a `'use client'` page didn't stop the prerender when measured on Next 15.5. `apps/dual-build-fixture` builds without the variable, serves with it, and checks that `/edit` carries the served key. Two more things make the image tier-independent:

- **No `clerkMiddleware`.** Delete the `middleware.ts` that `canopycms init --auth clerk` generates. The middleware reads the build-time key rather than the provider's prop, and it needs `CLERK_SECRET_KEY` on the Lambda (see [Security Model](#security-model)). CanopyCMS doesn't depend on it: `createNextCanopyContext` wraps the Clerk plugin in `CachingAuthPlugin`, which verifies each request's token (an `Authorization` bearer or the `__session` cookie) with `CLERK_JWT_KEY` alone. What you give up is having signed-out requests turned away before they reach the app. A signed-out visitor to `/edit` gets the editor, whose API calls are rejected, so send them to sign-in yourself, for instance by rendering Clerk's `<RedirectToSignIn />` when `useAuth()` reports them signed out.
- **Per-tier values in the Lambda's `environment`.** Pass the publishable-key variable to `CanopyCmsService` alongside `CLERK_JWT_KEY`; both are public. The `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` build arg then no longer decides which Clerk instance the editor uses. Other `NEXT_PUBLIC_CLERK_*` settings are inlined at build the same way, and the common ones (`signInUrl`, `proxyUrl`, `domain`) have matching provider props.

This is a supported shape that nobody has yet run against a real Clerk instance: what CanopyCMS does with the token is read from its source, and the fixture uses a fake key. On a first live deploy, check sign-in from `/edit`, a save, and an editor request after the tab has sat idle longer than a Clerk session token lives. Without the middleware nothing on the server refreshes an expired `__session` cookie, and `verifyTokenOnly()` rejects it.

### Preview Support

Add `useCanopyPreview` to your page components so the editor can show live previews:

```tsx
'use client'
import { useCanopyPreview } from 'canopycms/client'

export function PageView({ data }: { data: PageContent }) {
  const { data: liveData } = useCanopyPreview<PageContent>({
    initialData: data,
  })
  return (
    <article>
      <h1>{liveData.title}</h1>
    </article>
  )
}
```

## Step 2: Generate AWS Deployment Artifacts

```bash
npx canopycms init-deploy aws
```

This creates:

- `Dockerfile.cms` — Lambda Web Adapter image
- `.dockerignore` — keeps `.env*` and `infrastructure/` out of the build context
- `.github/workflows/deploy-cms.yml` — CI/CD workflow
- `cdk.json` — CDK app configuration; `cdk deploy` resolves the app through this
- `infrastructure/bin/app.ts` — CDK app entry point
- `infrastructure/lib/cms-stack.ts` — the stack itself, yours to edit
- `infrastructure/tsconfig.json` — compiler settings for type-checking the CDK app

The install and build commands in `Dockerfile.cms` and the workflow are written
for the package manager the command detects (npm, pnpm, or Yarn — from your
`packageManager` field, else your lockfile). For pnpm the image's install also
gets `pnpm-workspace.yaml`, where pnpm 11 keeps its `allowBuilds` decisions. The
deploy trigger branch comes from `origin/HEAD`, and the worker's repo from your
`origin` remote.

`init-deploy aws` never overwrites a file you already have without asking, and
`--non-interactive` skips them — re-run it with `--force` to replace them. The one existing file it edits is `tsconfig.json`: it
adds `infrastructure` to `exclude`, because the CDK app imports `aws-cdk-lib`
and your app's own `next build` would otherwise type-check it. A `tsconfig.json`
with comments, or one that inherits `exclude` through `extends` with no list of
its own, is left alone, and the command asks you to make that edit. It asks the
same when there is no `tsconfig.json`.

The CDK app is type-checked separately, with `infrastructure/tsconfig.json`.
`cdk.json` runs the app through tsx, which does not check types, so without that
check a misspelled `CanopyCmsService` prop is dropped silently and the deploy
uses the prop's default. The generated workflow runs
`tsc --noEmit -p infrastructure` before deploying; run it yourself after editing
the stack. `infrastructure/tsconfig.json` extends your `tsconfig.json`, so that
check fails until the project has one.

## Step 3: Test Locally in Dev Mode

Before deploying, test the full workflow locally:

```bash
# canopycms.config.ts says mode: 'dev' -- that is the value to keep (see
# "Operating mode" below); a deployment overrides it at run time.
npm run dev

# In another terminal, initialize the auth cache:
npx canopycms worker run-once

# Visit http://localhost:3000/edit
```

In dev mode, CanopyCMS:

- Creates a local bare repo at `.canopy-dev/remote.git`
- Uses `CachingAuthPlugin` with file-based cache (same code path as prod)
- Queues PR tasks to `.canopy-dev/.tasks/` (processed by `run-once`)

## Operating mode

CanopyCMS's `mode` decides where the workspace lives and how auth is enforced.
The deployed CMS must run in **`prod`** mode; dev mode resolves its workspace to
`<cwd>/.canopy-dev`, and Lambda's filesystem is read-only outside `/tmp`, so the
first write fails with `EROFS`.

**Leave `mode: 'dev'` in `canopycms.config.ts` anyway.** That one file is loaded
by three different things — `next dev` locally, `next build` inside the
deployment image, and the deployed server. `next dev` needs dev. `next build`
reads the working tree in either mode, so it needs nothing from prod, and a
`mode: 'prod'` literal would only hold the image build to prod-mode checks it
has no reason to meet: `gitBotAuthorName`/`gitBotAuthorEmail`, and an auth
plugin that verifies credentials.

The deployed value therefore comes from the environment, in two halves:

| Where                        | Variable                       | Set by                                               | Why it can't be the other one                                                                          |
| ---------------------------- | ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Server (Lambda), at run time | `CANOPY_MODE=prod`             | `CanopyCmsService` — automatic, nothing to configure | Must be absent during `next build`, so it cannot be baked into the image                               |
| Browser (editor bundle)      | `NEXT_PUBLIC_CANOPY_MODE=prod` | the generated stack, as a Docker **build arg**       | The editor page imports `canopycms.config.ts` directly, so its copy of `mode` is inlined at build time |

Both are resolved by `resolveOperatingMode`
(`packages/canopycms/src/operating-mode/mode-env.ts`), which runs inside
config validation — so `defineCanopyConfig` and `composeCanopyConfig` both get
it — wins over the config literal, and **throws** on any value
other than `prod`/`dev` rather than falling back — a typo like
`CANOPY_MODE=production` would otherwise deploy dev auth semantics silently.

Both are wired up by `canopycms init-deploy aws`; you only need this section if
you hand-edit the stack or the Dockerfile, or build the image some other way:

- `environment: { CANOPY_MODE: ... }` on `CanopyCmsService` accepts only
  `'prod'`, and rejects anything else at synth.
- **Set `NEXT_PUBLIC_CANOPY_MODE=prod` as a constant in the image's build
  stage**: an `ENV` line in your own Dockerfile, or
  `--build-arg NEXT_PUBLIC_CANOPY_MODE=prod` against the generated one. Every
  deployed tier runs `prod`, so one image still serves them all, and the
  build's own content reads stay in dev mode, because `resolveOperatingMode`
  reads this variable only where `window` exists. Expect one browser console
  warning per editor page load,
  `CanopyCMS: NEXT_PUBLIC_CANOPY_MODE="prod" overrides config.mode="dev"`; that
  is the override working.
- **Without it, the browser resolves `dev`,** and the scaffolded edit page
  (`edit-page.tsx.template`) selects dev auth rather than Clerk against a
  server that accepts only Clerk tokens, unless `NEXT_PUBLIC_CANOPY_AUTH_MODE=clerk`
  was also set at build. That is the only thing CanopyCMS's client code takes
  from the mode: the editor's capability checks answer the same in both modes,
  and `supportsPullRequests`, the one that differs, is only consulted on the
  server.
- **Don't compute `mode` in `canopycms.config.ts` from either variable.** Not
  from `NEXT_PUBLIC_CANOPY_MODE`: it is set while `next build` runs, and
  Next.js inlines `NEXT_PUBLIC_*` into server bundles too, so the build would
  resolve `prod` and meet the prod-mode checks the `dev` literal keeps out of
  it (see [Operating mode](#operating-mode)). Not from `CANOPY_MODE` either
  (`process.env.CANOPY_MODE === 'prod' ? 'prod' : 'dev'`): Next.js doesn't
  inline it into the browser bundle, so that literal is always `dev` there,
  while server code on the Lambda gets `prod`. The server half looks
  right, and the missing browser half goes unnoticed.

## Step 4: CDK Stack

Step 2 scaffolded the CDK app. Install what it needs to run:

```bash
npm install --save-dev canopycms canopycms-cdk aws-cdk-lib constructs tsx aws-cdk
```

All six are load-bearing: `cdk.json` runs
`node --import tsx infrastructure/bin/app.ts`, which imports `canopycms-cdk`,
`aws-cdk-lib` and `constructs` — and `canopycms-cdk` itself peer-depends on
`canopycms` (its worker re-export) — and pinning `aws-cdk` keeps the deploying
CLI version reproducible instead of whatever `npx` fetches that day. The
generated workflow checks for them before deploying, so a missing one fails
with a named error rather than an `ERR_MODULE_NOT_FOUND` several minutes into
`cdk deploy`.

### What to fill in

`infrastructure/bin/app.ts` reads its configuration from the environment so the
same file works locally and in CI. The generated file marks each one; the ones
without a default refuse to synth when unset, deliberately — every one of them
has a silent-failure mode that is far more expensive to diagnose after a
successful deploy.

| Variable                                     | Required | Notes                                                                                                                                                                                |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN_SECRET_ARN`                    | yes\*    | **Full** ARN including the six-character suffix — it goes verbatim into the worker's IAM policy, so a name-based ARN silently never matches and the worker gets AccessDenied at boot |
| `CLERK_SECRET_KEY_SECRET_ARN`                | yes      | Full ARN, same reason                                                                                                                                                                |
| `GITHUB_TOKEN_SECRET_JSON_FIELD`             | no       | Set only if that secret holds a JSON document rather than the bare token; names the key to read out of it. See [JSON secret documents](#json-secret-documents)                       |
| `CLERK_SECRET_KEY_SECRET_JSON_FIELD`         | no       | Same, for the Clerk secret                                                                                                                                                           |
| `GITHUB_APP_ID`                              | no       | GitHub App authentication instead of a token — see [Authenticating as a GitHub App](#authenticating-as-a-github-app). Set all three App variables or none                            |
| `GITHUB_APP_INSTALLATION_ID`                 | no       | The App's installation on _this_ repository, not the App ID                                                                                                                          |
| `GITHUB_APP_PRIVATE_KEY_SECRET_ARN`          | no       | Full ARN of the secret holding the App's PEM. ARN-only: the key is multi-line and never reaches the worker as a plain value                                                          |
| `GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD`   | no       | Set only if that secret holds a JSON document rather than the bare PEM                                                                                                               |
| `CLERK_JWT_KEY`                              | yes      | Clerk's public JWKS PEM. Unset, Clerk falls back to a network JWKS fetch and the no-internet Lambda hangs at sign-in                                                                 |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`          | no       | Deploys fine when empty and ships an editor that cannot sign in                                                                                                                      |
| `CANOPY_BOOTSTRAP_ADMIN_IDS`                 | no       | Comma-separated Clerk user IDs granted admin on first boot                                                                                                                           |
| `CANOPYCMS_DEPLOYMENT_NAME`                  | no       | Defaults to `prod`. Two stacks sharing one GitHub repo **must** differ — see [Two deployments, one repository](#two-deployments-one-repository)                                      |
| `CMS_DOMAIN_NAME` / `CMS_HOSTED_ZONE_DOMAIN` | no       | Set both to add CloudFront + Route53; leave unset to use the Lambda Function URL directly                                                                                            |

\* Required unless you set the `GITHUB_APP_*` variables instead. A personal
access token is the default; exactly one of the two credentials must be
configured, and setting both is refused at synth.

Then edit `infrastructure/lib/cms-stack.ts` for anything beyond that — memory
and concurrency, `AssetSupport` for media (a commented block in the generated
file: uncomment it, then pass the resulting `assetSupport` to
`CanopyCmsDistribution`'s `assetSupport` prop, which attaches its CloudFront
behaviors in the only safe order for you), or a distribution you already own.

`githubOwner` / `githubRepo` in `infrastructure/bin/app.ts` are prefilled from
your `origin` remote. Check them: they decide which repository the worker
pushes branches and opens PRs against.

### Why `cdk.json`'s `context` is empty

`cdk init` pins a long list of feature flags into new projects. This scaffold
deliberately pins none: the `canopycms-cdk` constructs are developed and tested
under aws-cdk-lib's own defaults, so an inherited flag set would be untested
here. Add flags if you need them, but note that a flag which only existed in
CDKv1 is rejected outright at synth (`UnsupportedFeatureFlag`).

### Deploy

```bash
cdk bootstrap                        # once per account/region
npx tsc --noEmit -p infrastructure   # cdk synth does not check types
cdk synth                            # confirm it builds before touching the account
cdk deploy CanopyCms
```

`cdk synth` needs the required variables above but no AWS credentials, as long
as you leave `CMS_DOMAIN_NAME` unset — `CanopyCmsDistribution` resolves your
hosted zone with a context lookup, which needs a real account.

## Step 5: CI/CD

The generated `.github/workflows/deploy-cms.yml` runs `cdk deploy`, and that is
deliberately the **only** thing that ships code.

The stack passes the CMS image as `lambda.DockerImageCode.fromImageAsset('.', {
file: 'Dockerfile.cms' })` — a CDK-built asset. `cdk deploy` builds it,
publishes it to the CDK bootstrap assets repository, and points the Lambda at
it as part of the change set. It also rolls the EC2 worker, because
`CanopyCmsService` gives the worker Auto Scaling Group a rolling
`UpdatePolicy`; without that, a changed worker bundle would sit unused in a
launch template until the next spot interruption.

> **Do not add an ECR push plus `aws lambda update-function-code` alongside
> it.** That builds the image twice and leaves the function's image URI out of
> sync with CloudFormation's view of it — the next `cdk deploy` that touches
> the function silently reverts your code to the CDK asset. If you want to
> control the image tag yourself, switch the stack to
> `DockerImageCode.fromEcr(repo, { tagOrDigest })` and keep `cdk deploy` as the
> single deployer. Pick one mechanism.

Prerequisites that an update-function-code pipeline did not need:

1. **CDK bootstrap** in the target account and region (`cdk bootstrap`).
2. **A broader OIDC role.** It must be able to assume the CDK bootstrap roles
   (`cdk-hnb659fds-*-deploy-role`, `-file-publishing-role`,
   `-image-publishing-role`, `-lookup-role`). `cdk deploy` mutates
   infrastructure, so this is a wider grant than updating a function's code.
3. **A Docker daemon on the runner.** The generated workflow's
   `ubuntu-24.04-arm` has one; read
   [Where the image is built](#where-the-image-is-built) before changing the
   runner. On a self-hosted runner, you also need Actions Runner v2.327.1 or
   later: the workflow's pinned actions run on Node 24, and their docs give
   that as the minimum.
4. **The CDK devDependencies from Step 4**, committed to `package.json`. The
   workflow checks for them before deploying, then type-checks the CDK app
   with `tsc --noEmit -p infrastructure`, which also needs `typescript` and
   `@types/node`. Next.js requires both in a TypeScript app.

### Repository secrets and variables

The Deploy step passes these through to `infrastructure/bin/app.ts`. The
required ones are read by `required()` there, so a missing value fails the
deploy at synth — before anything is changed in the account.

| Name                                              | Kind      | Required                                     |
| ------------------------------------------------- | --------- | -------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`                             | secret    | yes                                          |
| `CANOPY_GITHUB_TOKEN_SECRET_ARN`                  | secret    | yes (see note below)                         |
| `CLERK_SECRET_KEY_SECRET_ARN`                     | secret    | yes                                          |
| `AWS_REGION`                                      | variable  | yes                                          |
| `CLERK_JWT_KEY`                                   | variable  | yes (see note below)                         |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`               | variable  | no, but the editor cannot sign in without it |
| `CANOPY_BOOTSTRAP_ADMIN_IDS`                      | variable  | no                                           |
| `CANOPYCMS_DEPLOYMENT_NAME`                       | variable  | no (defaults to `prod`)                      |
| `CANOPY_GITHUB_TOKEN_SECRET_JSON_FIELD`           | variable  | no (only for a JSON secret document)         |
| `CLERK_SECRET_KEY_SECRET_JSON_FIELD`              | variable  | no (only for a JSON secret document)         |
| `CANOPY_GITHUB_APP_ID`                            | variable  | no (only for GitHub App auth)                |
| `CANOPY_GITHUB_APP_INSTALLATION_ID`               | variable  | no (only for GitHub App auth)                |
| `CANOPY_GITHUB_APP_PRIVATE_KEY_SECRET_ARN`        | secret    | no (only for GitHub App auth)                |
| `CANOPY_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD` | variable  | no (only for a JSON secret document)         |
| `CMS_DOMAIN_NAME`, `CMS_HOSTED_ZONE_DOMAIN`       | variables | no (enables CloudFront + Route53)            |

`CANOPY_GITHUB_TOKEN_SECRET_ARN` is required **unless** you configure GitHub App
authentication instead, in which case it must be left unset — exactly one of the
two. See [Authenticating as a GitHub App](#authenticating-as-a-github-app).

The App ID and `_JSON_FIELD` entries are variables, not secrets, because they identify or
name something rather than carry key material; the App private key reaches Actions only as
the ARN of the secret holding it.

> **Why is `CLERK_JWT_KEY` a variable and not a secret?** Because it is a _public_ key —
> Clerk's JWKS PEM, retrievable from your instance's public JWKS endpoint, and used only to
> verify signatures. It is `required` because without it `@clerk/nextjs` falls back to
> fetching JWKS over the network and the internet-less CMS Lambda hangs at sign-in; that
> makes it load-bearing, not confidential. Storing it as an Actions _secret_ also works, but
> it is worth being precise: classifying it as a secret is what invites the conclusion that
> the CMS Lambda accepts secrets, which it does not (see
> [Security Model](#security-model)). The genuinely sensitive Clerk value is
> `CLERK_SECRET_KEY`, which lives in Secrets Manager and is read by the worker. CanopyCMS
> doesn't need it on the Lambda; `clerkMiddleware` does, as that section explains.

> **Why `CANOPY_GITHUB_TOKEN_SECRET_ARN` and not `GITHUB_TOKEN_SECRET_ARN`?** GitHub
> reserves the `GITHUB_` prefix and rejects any Actions secret or variable whose name
> starts with it, so the obvious name cannot be created. The generated workflow maps this
> secret onto an unprefixed `GITHUB_TOKEN_SECRET_ARN` environment variable, which is what
> the CDK app reads — only the _secret_ name needs the prefix. Every other `CANOPY_GITHUB_*`
> entry above is spelled that way for the same reason, and mapped the same way.

> **CloudFront requires a us-east-1 certificate.** When `CMS_DOMAIN_NAME` is set,
> `CanopyCmsDistribution` creates an ACM certificate in the **stack's own region**, and
> CloudFront only accepts certificates from `us-east-1`. So with a domain configured,
> `AWS_REGION` must be `us-east-1` — or you must create the certificate in a us-east-1
> stack yourself and pass it via the construct's `certificate` prop. The construct now
> fails at synth with that message rather than letting the deploy fail obscurely.

The workflow deploys the stack **by name**, not with `--all`: `--all` would
also deploy any unrelated stacks you keep in the same repository, on every
content merge. Rename the stack in `infrastructure/bin/app.ts` and you must
rename it in the workflow's Deploy step too.

### Build-time client keys

The generated stack bakes `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
`NEXT_PUBLIC_CANOPY_MODE` into the image. Next.js inlines them into the
**client** bundle at image-build time, so they have to reach the image _build_ —
a Lambda environment variable is far too late. Because CDK builds the image,
they must be passed through `buildArgs` in the stack, not through a
`docker build --build-arg` step in CI:

```ts
cmsDockerImage: lambda.DockerImageCode.fromImageAsset('.', {
  file: 'Dockerfile.cms',
  // No `platform`: see "Where the image is built" below.
  buildArgs: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
    NEXT_PUBLIC_CANOPY_MODE: 'prod',
  },
}),
```

The workflow sets the publishable key on the `cdk deploy` step from a
repository variable. If it is missing, the deploy still succeeds and the editor
ships with an empty publishable key. `NEXT_PUBLIC_CANOPY_MODE` is a literal;
[Operating mode](#operating-mode) explains why it is needed.

That bakes one Clerk instance into each image, which is what the generated
`clerkMiddleware` needs: the middleware reads the build-time publishable key, not
the key a `<ClerkProvider>` receives. Without the middleware, the key can come
from a run-time variable instead, and one image serves every tier; see
[Dual Build Support](#dual-build-support).

### Where the image is built

`cdk deploy` builds the CMS image on whichever machine runs it, but that machine
does not decide what ends up in the image:

- **The image's architecture is the docker build's target platform**, and
  `CanopyCmsService` fixes that from its `architecture` prop (`ARM_64` by
  default). It always passes the function a resolved architecture, and CDK
  derives a `fromImageAsset` image's build platform from it. Leave `platform`
  off `fromImageAsset`: an explicit one overrides the derived value, and an
  image built for the other architecture cannot run on the function: its
  binaries are for the wrong architecture, which
  [`execve` rejects][execve-enoexec]. An arm64 image on an x86_64 function
  [fails at invoke with `Runtime.InvalidEntrypoint`][lambda-arch-mismatch].
  A prebuilt `fromEcr` image has no build for CDK to steer, so build it with
  the matching `--platform` yourself.
- **Everything native comes from inside the build.** The Node binary comes
  from the `node:22-slim` base image, pulled for the target platform; git from
  an `apt-get` step; sharp and its libvips from the package install. All of
  those run inside the build, and `.dockerignore` keeps the host's
  `node_modules` out of the build context.

What the host does decide is whether that build runs natively, and so how fast:

| `cdk deploy` runs on         | Building the default `linux/arm64` image                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Silicon Mac            | Native, fast                                                                                                                                                                                                                                                                                                                                                                          |
| GitHub `ubuntu-24.04-arm`    | Native. The generated workflow's runner: a standard GitHub-hosted runner in private repositories [since 2026-01-29][gh-arm64-private], with 2 vCPUs there. The workflow's own dependency install runs on arm64 Linux too, so native dependencies install their linux-arm64 builds                                                                                                     |
| GitHub `ubuntu-latest` (x86) | Emulated: the build runs under QEMU, which [Docker's GitHub Actions guide][docker-gha-multi-platform] adds with `docker/setup-qemu-action`. [Docker's docs][docker-multi-platform] warn emulation can be much slower for compute-heavy work such as compilation, and emulated arm64 builds have failure reports on 24.04 runners ([actions/runner-images#11561][runner-images-11561]) |

[lambda-arch-mismatch]: https://jasoncameron.dev/posts/aws-lambda-handler-gotchas
[execve-enoexec]: https://man7.org/linux/man-pages/man2/execve.2.html#ERRORS
[gh-arm64-private]: https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/
[docker-gha-multi-platform]: https://docs.docker.com/build/ci/github-actions/multi-platform/
[docker-multi-platform]: https://docs.docker.com/build/building/multi-platform/
[runner-images-11561]: https://github.com/actions/runner-images/issues/11561

The asset's hash covers its build inputs — the directory contents, `file`,
`buildArgs` and the platform among them — and not the machine that built it, so
the same inputs give the same asset hash on a Mac or in CI.

### Worker outage during deploy

The worker ASG has `minCapacity` and `maxCapacity` of 1, so the rolling update
is terminate-then-relaunch with a short gap while the replacement boots
(package installs and the EFS mount — roughly 2–4 minutes). This is safe: the
task queue and branch workspaces live on EFS and are picked up on boot, and the
Lambda's Save/Publish enqueue paths are unaffected. Tasks interrupted mid-flight
are recovered by the worker's orphaned-task sweep, which runs every task-queue
cycle.

See `examples/aws-deployment/deploy-cms.yml` for the full workflow.

## Step 6: Create Secrets

Before deploying, create these secrets in AWS Secrets Manager:

| Secret                       | Value                        | Used by                         |
| ---------------------------- | ---------------------------- | ------------------------------- |
| `canopycms/github-token`     | GitHub PAT with `repo` scope | EC2 worker (push, PR creation)  |
| `canopycms/clerk-secret-key` | Clerk backend secret key     | EC2 worker (user cache refresh) |

CanopyCMS's code on the Lambda needs neither secret — only the EC2 worker reads them.
Keeping `clerkMiddleware` changes that for the Clerk key; see [Security Model](#security-model).

### Authenticating as a GitHub App

A personal access token is the default and is fully supported; this section is
for organisations that require an App. Registering an App under an organisation
takes an owner of that organisation (or a GitHub App manager for all its Apps),
which many adopters are not, so nothing here deprecates the token or asks you to
migrate.

What an App buys you, when you can have one: its private key does not expire,
it acts as itself rather than as the person who created it, and it survives that
person leaving. A fine-grained PAT expires within a year and dies with its
creator's account.

#### Register it with `canopycms init-github-app`

```bash
canopycms init-github-app create -- \
  aws secretsmanager create-secret --name canopycms/github-app-key --secret-string file:///dev/stdin
```

The command writes an HTML form to a temp file and prints the path. Open it in a
browser **signed in to GitHub as the repository's owner** (for an organisation:
an owner, or a GitHub App manager for all its Apps), review the
permissions GitHub shows you, and click Create; then install the App on the
content repository and press Enter. It prints `GITHUB_APP_ID` and
`GITHUB_APP_INSTALLATION_ID` — both numeric, both read from the API rather than
copied off a URL.

Everything after `--` is run with the private key on its **standard input**, so
the key never touches disk and never appears in a process listing. That example
stores it in Secrets Manager; any command that reads a secret from stdin works
just as well, and `--key-out <path>` writes a `0600` file instead if you have no
such command. The command's own output is shown to you, which is how you get the
secret's full ARN — `Secret.fromSecretCompleteArn` needs the ARN including its
six-character suffix, not the friendly name.

If that command fails, `create` keeps the key in memory and asks for a **file
path** to write it to (created `0600`, never overwriting); commands are not
accepted at that prompt. A first word after `--` containing `=` is refused: set
variables in your shell before `canopycms`, e.g.
`AWS_PROFILE=prod canopycms init-github-app create -- aws …`.

If you already keep one JSON document per environment, create the secret
yourself and point `GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD` at the field —
`init-github-app` deliberately will not edit an existing document, because a
read-modify-write against a shared credential can silently drop its other
fields.

Prefer to do it by hand? Create the App under the account's settings with
exactly the permissions below, install it on the content repository, and
generate a private key from the App's "Private keys" section.

#### The permissions, and why each one

| Permission                  | Why                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Contents: read & write      | cloning, fetching and pushing content branches over HTTPS, and deleting a remote branch ref |
| Pull requests: read & write | opening and updating the pull request that carries an edit, and the draft/ready transitions |
| Metadata: read              | granted automatically alongside any repository permission                                   |

**Nothing else.** Not Issues, not Workflows, not Administration, and no
organisation permissions. That set is not advice — it is derived from every
GitHub call the worker makes, declared as `CANOPY_APP_PERMISSIONS` in
`packages/canopycms/src/cli/init-github-app.ts` with the call site that forces
each entry, and held there by a test that drives the worker's dispatch table and
fails if a call is added that the set does not cover.

One known gap, reported in public GitHub issues and not reproduced here: GitHub
refuses a push that creates or updates a file under `.github/workflows/` without
the workflows permission (the `workflow` scope, for a classic PAT), and a content
branch rebased across a base-branch workflow change may count as one.

**Register one App per site.** Anyone holding an App's key can mint a token for
any of its installations, so one App shared across sites lets a compromise of
one site's secret store write to every other site's repository — see
[ARCHITECTURE.md](../ARCHITECTURE.md#why-one-github-app-per-site-not-one-shared-across-an-organisation).

#### Check it before you trust it

```bash
aws secretsmanager get-secret-value --secret-id canopycms/github-app-key \
  --query SecretString --output text |
  canopycms init-github-app verify --app-id 123456 --key-stdin
```

Read-only and repeatable. It reports the permissions the installation actually
holds — flagging anything **missing** and anything **wider than intended**,
including a level stronger than needed — whether the installation is scoped to
selected repositories or to all of them, whether it has been suspended, whether
the App is installed exactly **once** (a second installation means this key
reaches another account's repositories), and whether a token can actually be
minted. That last one matters because **adding a permission to an App does not
reach existing installations until an account owner approves it**, so an App
whose settings page looks correct can still hold a stale grant. Any token it
mints is revoked immediately.

A check that could not run is reported as a failure, not passed over — "could
not list this App's installations" is not the same as "installed once", and only
one of those is a reason to trust the credential.

#### Then set these instead of `GITHUB_TOKEN_SECRET_ARN`

```
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_APP_PRIVATE_KEY_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:canopycms/github-app-key-AbCdEf
```

From the generated GitHub Actions workflow you set the matching repository
variables and secret, all `CANOPY_`-prefixed, which the workflow maps back onto
the unprefixed names above. See
[Repository secrets and variables](#repository-secrets-and-variables).

Four things worth knowing before you choose:

- **The private key is ARN-only.** There is no plain-value alternative and there
  cannot be one: the worker's configuration arrives as a `.env` file that systemd
  reads as `EnvironmentFile=`, where a newline starts a new variable, and a PEM
  is multi-line. Pasting the key into `GITHUB_APP_PRIVATE_KEY_SECRET_ARN` is
  caught at synth with a message saying so.
- **The key may live in a JSON document**, like any other credential here — set
  `GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD`. The worker also accepts a PEM whose
  newlines arrived as literal `\n` escapes, or one that was base64-wrapped to get
  it through a single-line field, so a key mangled in transit still boots.
- **The App's installation tokens last about an hour**, so the worker mints one
  on demand rather than reading a credential once at boot. Both halves of its
  GitHub access — the REST API and git-over-HTTPS — share a single token cache,
  so this costs roughly one extra API call an hour, not one per operation.
- **`GITHUB_APP_INSTALLATION_ID` is not the App ID**, and neither is the
  `Iv1.…` Client ID shown beside the App ID on the settings page. The
  installation id identifies the App's installation on your repository; an App
  installed on two accounts has one App ID and two installation ids. Both
  `init-github-app create` and `verify` print the pair, so you should not need to
  read either off a URL — but if you are doing it by hand, the installation id is
  the trailing number in the URL of the App's install page
  (`.../settings/installations/<installation_id>`).

### JSON secret documents

The table above is the simple shape: one secret per credential, whose entire
value _is_ the credential. If you instead keep one JSON document per
environment — a common convention, and what Secrets Manager's console offers
first — point the deployment at the field you want:

```
GITHUB_TOKEN_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app/prod-AbCdEf
GITHUB_TOKEN_SECRET_JSON_FIELD=CANOPYCMS_GITHUB_TOKEN
```

Those are the **environment variables the CDK app reads**, for a deploy from a laptop. From
the generated GitHub Actions workflow, set the repository variable
`CANOPY_GITHUB_TOKEN_SECRET_JSON_FIELD` instead
([why the prefix](#repository-secrets-and-variables)).

The worker then reads that key out of the document. Leave the `_JSON_FIELD`
variable unset and behaviour is exactly as before — the whole value is the
credential — so nothing changes for the single-value shape above.

Three things worth knowing before you choose:

- **Do not append the field to the ARN.** `arn:…:secret:my-app/prod-AbCdEf:CANOPYCMS_GITHUB_TOKEN::`
  is the ECS / CloudFormation dynamic-reference convention, and the worker does
  not use either — it calls `GetSecretValue`, which returns the whole document
  and does not parse that suffix. `CanopyCmsService` rejects such an ARN at
  synth rather than letting it reach the worker's IAM policy, where it would
  match nothing and produce AccessDenied at boot.
- **A missing or misspelled field fails loudly, at boot**, naming the field you
  asked for and the keys the document actually has. A secret that holds a JSON
  document with _no_ field configured is warned about on every boot, since the
  whole document would otherwise silently become the credential.
- **Only these credentials can come from a secret at all** — the GitHub token,
  the Clerk secret key, and (see
  [Authenticating as a GitHub App](#authenticating-as-a-github-app)) a GitHub App
  private key. If your document also holds `CLERK_JWT_KEY` and
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, those two still have to be supplied separately — as a repository variable and a build
  arg respectively. Both are public key material, so they are deliberately not
  routed through Secrets Manager; see [Security Model](#security-model).

### Rotating a secret

Update the secret's value in Secrets Manager. The running worker picks it up on
its own — **you do not need to redeploy or replace the instance.**

How long it takes, and why:

| Secret                 | Picked up within       | Noticed by                                                    |
| ---------------------- | ---------------------- | ------------------------------------------------------------- |
| GitHub token           | ~5 minutes (up to ~10) | a failed publish, or the git sync, which runs every 5 minutes |
| Clerk secret key       | ~15 minutes            | the auth-cache refresh                                        |
| GitHub App private key | not re-read            | — see below                                                   |

The re-read is **reactive**: the worker re-reads a secret only after the
operation using it has just failed, so a healthy deployment makes no
`GetSecretValue` calls at all between boots. That is also why rotation is not
instant — the worker finds out by trying and failing once.

For the GitHub token, **store the new value before you revoke the old one.**
Then the first publish to meet the revoked token normally re-reads straight away,
and its automatic retry goes out on the new token. Normally, not always: the
worker re-reads at most once every five minutes (and calls its credential
provider at most once a minute), and any failure — a sync, or an unrelated
publish — can use that read. If one landed shortly before your revocation, that
publish can still fail and need resubmitting. The two limits can also stack,
which is where the table's ~10 minutes comes from. Revoke first and a failure in
the gap re-reads the old value, so publishes can fail for up to about six
minutes.

A secret that is simply wrong, rather than rotated, does not turn into a loop.
The worker re-reads at most once every five minutes per secret, and when the
re-read comes back identical to the value it already holds it does not retry the
operation, since that retry could not succeed. It keeps checking indefinitely at
that rate, so a later correction is still picked up — it never gives up and it
never hammers. Twelve re-reads an hour per secret is the ceiling, and each is
normally one `GetSecretValue` call (up to four if the call itself is failing,
which is the existing boot-time retry).

Two things to know:

- **A GitHub App private key is read once, at boot.** To rotate one: generate
  the new key, store it in Secrets Manager, **replace the instance**
  (`cdk deploy`, or terminate it and let the ASG replace it), and only then
  delete the old key on GitHub. Delete first and nothing fails at once — tokens
  already minted keep working for up to an hour — then every publish fails with
  a 401 until the instance is replaced, and each branch that failed meanwhile
  must be resubmitted.
- **A plain env var is never re-read.** If you set `CANOPYCMS_GITHUB_TOKEN` or
  `CLERK_SECRET_KEY` directly instead of pointing at an ARN, the value is
  whatever the instance booted with. Re-reading an ARN you deliberately
  overrode would swap your override back out, so the worker leaves it alone.

## Content Publishing Flow

1. Editor creates/edits content in the CMS at `cms.docs.example.org/edit`
2. Editor clicks "Submit" → Lambda commits to branch, pushes to `remote.git` on EFS
3. EC2 worker picks up task (~5 seconds) → pushes branch to GitHub, creates PR
4. Reviewer merges PR on GitHub
5. Existing CI/CD pipeline rebuilds the static site and deploys to S3

## Settings Publishing Flow (Permissions & Groups)

Settings changes (permissions and groups) follow the same Lambda→worker pattern as content, using a dedicated settings branch named `canopycms-settings-{deploymentName}` (e.g., `canopycms-settings-prod`). See [Two deployments, one repository](#two-deployments-one-repository) below for how `deploymentName` is resolved and why it matters as soon as more than one deployment touches the same repo.

1. Admin changes permissions/groups in the CMS UI
2. Lambda commits changes to the settings branch workspace on EFS
3. Lambda pushes the commit to `remote.git` (local bare repo on EFS)
4. Lambda queues a `push-and-create-or-update-pr` task for the worker
5. EC2 worker dequeues the task, pushes the settings branch from `remote.git` to GitHub, and creates/updates a PR
6. Additionally, the worker's `syncGit()` pushes settings branches on every cycle as a safety net

## Two deployments, one repository

Two `CanopyCmsService` stacks can point at the same GitHub repo (e.g. a test stack and a prod stack, or two independently-deployed sites sharing one monorepo). If both are left at their defaults, **both resolve the same settings branch — `canopycms-settings-prod` — and fight over it**: whichever deployment's worker pushes last wins, permissions/groups PRs from one deployment get silently clobbered by the other's push, and reviewers see confusing, unattributable diffs on a single PR that's actually serving two unrelated CMS instances.

The fix is to give each stack a distinct `deploymentName`:

```typescript
new CanopyCmsService(this, 'Cms', {
  // ...
  deploymentName: 'prod', // this stack's settings branch: canopycms-settings-prod
})
```

`deploymentName` is stamped into the Lambda's `CANOPYCMS_DEPLOYMENT_NAME` environment variable and the worker's `.env`, and resolved with this precedence (see `resolveDeploymentName` in `packages/canopycms/src/operating-mode/deployment-name.ts`):

1. `CANOPYCMS_DEPLOYMENT_NAME` (stamped per-stack by this CDK prop) — wins
2. `deploymentName` in the shared repo's `canopycms.config.ts`
3. the operating mode's default (`prod` / `local`)

The env var deliberately wins over config: it's the one guaranteed to differ between two stacks sharing a repo, while `config.deploymentName` is checked out identically by both. If both are set and disagree, the Lambda logs a one-time warning naming both values and which one won.

Setting `CANOPYCMS_DEPLOYMENT_NAME` through the construct's `environment` prop still works and still wins over the `deploymentName` prop, but it is resolved at synth rather than passed through: the winning value is validated by the same rule as the prop (an invalid one fails `cdk synth` instead of crash-looping the Lambda at boot) and is written to **both** the Lambda's environment and the worker's `.env`. Prefer the `deploymentName` prop — it says the same thing in one place.

**Changing `deploymentName` (or `settingsBranch`) on a stack that already has a populated settings workspace is refused at boot, loudly** — it is not migrated automatically. Renaming the resolved settings branch would make CanopyCMS check out a _different_ orphan branch in the same on-disk workspace, which wipes `permissions.json`/`groups.json` with no history to recover them from (orphan branches share none). If you see this error, either restore the previous value or deliberately move the settings workspace aside first — see the error message for specifics.

## Base branch and settings branch: keeping the worker and the Lambda in step

Two more values have to agree between the Lambda and the EC2 worker, for the
same underlying reason as `deploymentName` above: each is read independently
by a different process, with no automatic reconciliation unless something
wires them together.

- **`CANOPYCMS_BASE_BRANCH`** — the worker's own copy of the GitHub
  repository's default branch, stamped once into the worker's `.env` at synth
  by `CanopyCmsService`'s `baseBranch` prop (default `'main'`). The Lambda
  instead reads `config.defaultBaseBranch` from `canopycms.config.ts` at
  request time.

  **Get this wrong and there is no working worker at all.**
  `verifyBaseBranchExists` throws when the named branch doesn't exist in the
  cloned `remote.git`; the worker's `start()` records the fatal error;
  `worker/index.ts` exits 1; systemd's `Restart=always` repeats that
  forever — a permanent crash loop, not a transient failure, until the value
  is fixed and the instance replaced. `rebaseActiveBranches` also fetches and
  rebases against the wrong lineage in the meantime.

- **`CANOPYCMS_SETTINGS_BRANCH`** — an explicit override for the settings
  branch name, mirroring `config.settingsBranch` in `canopycms.config.ts`.
  Stamped by `CanopyCmsService`'s `settingsBranch` prop; **unset by default**,
  in which case the worker falls through to the same computed name the Lambda
  uses (`canopycms-settings-<deploymentName>` — see
  [Two deployments, one repository](#two-deployments-one-repository) above).
  Leaving both unset is safe. Setting `config.settingsBranch` without also
  setting this prop is not: the Lambda's `getSettingsBranchName`
  short-circuits on `config.settingsBranch`, so the worker ends up owning a
  different branch than the Lambda writes to — the worker's per-cycle
  backstop push (`pushSettingsBranches`) then targets the wrong branch, and
  its "foreign settings branch" `[SYNC-M3]` warning misfires against the
  deployment's own branch.

**`infrastructure/lib/cms-stack.ts`, as generated by `canopycms init-deploy aws`,
derives both of these from your project's own `canopycms.config.ts` at synth
time** — it imports the config file directly and passes
`baseBranch: config.defaultBaseBranch` / `settingsBranch: config.settingsBranch`
into `CanopyCmsService`. So if you deploy through the generated stack, there is
nothing to keep in sync by hand: change `defaultBaseBranch`/`settingsBranch` in
`canopycms.config.ts` and the next `cdk deploy` picks it up. If you hand-roll
your own stack instead of using the generated one, you must set the
`baseBranch`/`settingsBranch` props on `CanopyCmsService` yourself, matching
`canopycms.config.ts` exactly — neither prop is validated against the shared
config for you.

Both props ARE validated at synth as git branch names: a value git itself would
refuse (whitespace, `..`, `~^:?*[\`, `@{`, a leading `-`, a leading or trailing
`/`, a component starting with `.` or ending with `.lock`) fails `cdk synth`
rather than deploying an instance that crash-loops. A `/` inside the name is
fine and expected — `release/v2` and `epic/foo` are ordinary branch names, and
the worker keeps the raw name for git refs, sanitizing it only when deriving a
workspace directory name.

## Worker observability

The EC2 worker's stdout/stderr ships to CloudWatch Logs by default via the
amazon-cloudwatch-agent — no SSM or shell access needed to see what it's doing.
The CMS Lambda and the asset transform Lambda (if you use `AssetSupport`) each
get their own dedicated log group too, on the same convention.

- **Log groups**: all created by CDK with a custom `/canopycms/...` name,
  90-day default retention, and `RemovalPolicy.DESTROY` — never the
  CloudFormation-implicit `/aws/lambda/<function-name>` group Lambda would
  otherwise auto-create (which CDK can't manage: infinite retention, and it
  survives `cdk destroy`). Filter on the `/canopycms/` prefix in the
  CloudWatch console to see every deployment's log groups at once.
  | Component | Default log group name | Retention override | Name override | Construct property |
  | --- | --- | --- | --- | --- |
  | EC2 worker | `/canopycms/<stackName>/worker` | `workerLogRetention` | `workerLogGroupName` | `service.workerLogGroup` |
  | CMS Lambda | `/canopycms/<stackName>/cms` | `cmsLogRetention` | `cmsLogGroupName` | `service.cmsLogGroup` |
  | Transform Lambda | `/canopycms/<stackName>/transform` | `transformLogRetention` | `transformLogGroupName` | `assetSupport.transformLogGroup` |

  Name overrides are also useful if you instantiate `CanopyCmsService` or
  `AssetSupport` twice in one stack, since the default names would otherwise
  collide.

- **Log streams**: one per instance id for the worker — a new stream appears
  every time the spot worker is replaced (including by the rolling update
  described in [Redeploying updates the worker too](#redeploying-updates-the-worker-too)
  below). The Lambdas use their usual per-container-instance streams.
- **Timestamps**: the worker emits its own ISO-8601 UTC timestamp (plus a level
  tag) on every line, via `workerLog`/`workerLogWarn`/`workerLogError` in
  `packages/canopycms/src/worker/log.ts` — see
  [`.claude/future-tasks/resolved/worker-log-timestamps.md`](../.claude/future-tasks/resolved/worker-log-timestamps.md)
  for how CloudWatch's own `multi_line_start_pattern` is keyed on that prefix,
  which is why all worker code must log through those helpers rather than bare
  `console.*`.
- **On-instance file**: `/var/log/canopy-worker/worker.log`, bounded by a
  logrotate policy (10 MB, 5 rotations, compressed). The CloudWatch agent tails
  this file — `journalctl -u canopy-worker` no longer carries the worker's
  output, though `systemctl status canopy-worker` still works for a basic
  running/not-running check.
- **Org tagging**: tag aspects applied stack-wide (`Tags.of(stack).add(...)`)
  cascade to every log group automatically like any other CDK resource, so
  org-wide tagging policies need no Canopy-specific configuration.

## Redeploying updates the worker too

The worker's Auto Scaling Group has an `UpdatePolicy` (`rollingUpdate` with
`minInstancesInService: 0`, since the ASG's `minCapacity`/`maxCapacity` are
both 1), so `cdk deploy` actually terminates and relaunches the EC2 instance
whenever anything in its launch template changes — most commonly a new
worker code bundle, but also an AMI refresh, instance-role change, or
user-data edit. Without this, CloudFormation's default behavior for an ASG
behind a changed launch template is to update the template resource and stop
there: the running instance keeps its old user-data (and therefore the old
worker bundle) until a spot interruption or a manual terminate happens to
replace it — so a plain `cdk deploy` would silently ship every other change
except the one to the worker.

Because `minInstancesInService` must be `0` here, every such deploy causes a
short worker outage (replacement boot time — installing git/unzip/nodejs/
efs-utils and mounting EFS — is typically 2-4 minutes). This is expected and
safe:

- The task queue and branch workspaces live on EFS, not on the instance, so
  the replacement worker picks up exactly where the old one left off.
- The Lambda's Save/Publish paths only enqueue task files onto EFS and never
  talk to the worker directly, so they queue up normally during the outage
  instead of failing.
- A task that was actually being processed when the old instance was
  terminated is automatically recovered: the worker re-checks
  `.tasks/processing/` for stranded tasks on every task-queue poll cycle (not
  only at its own boot), so a task orphaned by the old instance's termination
  gets moved back to `pending/` and retried once it's old enough (5 minutes
  by default) — no manual intervention needed.

There is deliberately no `cfn-signal`/readiness gate on this update: the
worker's systemd unit is `Type=simple` with `Restart=always`, so
`systemctl start` reports success the instant the process execs, regardless
of whether it then crash-loops — a real readiness signal would need to poll
`worker-status.json` or `systemctl is-active` before signaling, which isn't
implemented yet. If you need to confirm a redeploy actually took (e.g. after
a worker code change), check the new instance's log stream (see
[Worker observability](#worker-observability) above) or
`npx canopycms worker run-once`-style diagnostics rather than relying on
`cdk deploy` exiting cleanly as proof.

## Security Model

| CMS Lambda                       | EC2 Worker                                                               |
| -------------------------------- | ------------------------------------------------------------------------ |
| No internet access               | Outbound HTTPS only                                                      |
| No sensitive secrets             | GitHub token _or_ an App private key, + Clerk key (from Secrets Manager) |
| Public keys only (CLERK_JWT_KEY) | Full API access                                                          |
| Read/write EFS only              | Read/write EFS + internet                                                |

**The CMS Lambda is intended to receive public configuration only.** Every genuinely
sensitive value is meant to go to the worker instead: pass the GitHub token and Clerk
secret key to `CanopyCmsService` as `githubTokenSecretArn` / `clerkSecretKeySecretArn`
(or, for App auth, `githubAppPrivateKeySecretArn` in place of the first),
and the worker reads them at boot with its own IAM grant. The Lambda's `environment`
should carry nothing you would mind reading in the output of
`aws lambda get-function-configuration`.

An earlier version of this paragraph justified the absence of a Secrets-Manager-fetch path
on the Lambda by saying it "could not use one if it had it, having no internet access."
**That was wrong**, and it mattered, because it made the absence look like a closed design
decision rather than an open gap. The Lambda runs in `PRIVATE_ISOLATED` subnets of a VPC
this construct creates, and a VPC endpoint reaches an AWS service from there **without any
internet route** — which is not hypothetical here: `CanopyCmsService` already adds a
gateway endpoint for S3 for exactly this reason, because otherwise the Lambda's asset
writes would hang. Secrets Manager needs the _interface_ variety rather than the free
gateway one, so it carries an hourly and per-GB charge; that is a cost argument, not an
impossibility argument.

So the honest statement of today's position is: the Lambda holds no secrets **because
nothing has built that path yet**, not because the path cannot exist.

Concretely, for Clerk: `CLERK_JWT_KEY` (a public PEM) belongs on the Lambda, and
`CLERK_SECRET_KEY` (full Clerk API access) does not. CanopyCMS's own request authentication
never reads the secret there: `createNextCanopyContext` wraps the Clerk plugin in
`CachingAuthPlugin`, which checks each token with `verifyTokenOnly()` (the JWT key only) and
takes user and group metadata from the auth cache on EFS. The calls that need the secret, to
Clerk's backend API for that cache, run on the worker.

**`clerkMiddleware` is the exception.** `canopycms init --auth clerk` generates one
(`middleware-clerk.ts.template`), and it throws on every request it matches unless it can
resolve a secret key; `jwtKey` doesn't satisfy that check. So the posture above holds for a
deployment without that middleware, and one that keeps it needs `CLERK_SECRET_KEY` in the
Lambda's environment, or a fetch of it at run time (see
`.claude/future-tasks/deploy-test-lambda-plaintext-clerk-secret.md`). What dropping the
middleware gives up is under [Dual Build Support](#dual-build-support). The middleware shape
was deploy-tested against a real Clerk instance in 2026-07; the shape without it has not
been yet, so test sign-in early.

If the CMS Lambda is compromised, an attacker can read/write content on EFS but cannot exfiltrate data, push to GitHub, or access any external service.

### CloudFront OAC and request body signing

CloudFront reaches the Lambda Function URL through an Origin Access Control (OAC) with SigV4 signing (`SigningBehavior: always`), so the Function URL rejects any request that isn't signed by this distribution — a direct hit to the Function URL is refused.

This has one consequence adopters don't need to think about, but that's worth knowing if you see unexplained 403s: **CloudFront signs origin requests but never hashes the request body.** For any request that carries a body (POST/PUT/PATCH — saves, publishes, permission/group updates), the _viewer_ request must already include an `x-amz-content-sha256` header containing the lowercase-hex SHA-256 digest of the exact payload. If that header is missing, Lambda's signature verification fails the payload check and responds 403, even though the request reached CloudFront correctly.

CanopyCMS's generated API client (`packages/canopycms/src/api/client.ts`, via the shared `computeContentSha256Hex` helper in `packages/canopycms/src/api/request-body-hash.ts`) computes and attaches this header automatically for every JSON request body, using WebCrypto (`crypto.subtle.digest`). GET/DELETE requests without a body are unaffected. The header is a no-op on non-AWS deployments (it's just an extra header nothing enforces), so this doesn't need to be conditionally enabled per environment.

**Known limitation:** raw `FormData` bodies (multipart uploads) can't be hashed this way — the multipart boundary is generated by the runtime at send time, so the final bytes aren't known until after the header would need to be set. No current CanopyCMS endpoint sends a `FormData` body. (The `assets.upload` endpoint nominally takes a JSON body, but its server schema expects a `Buffer`/`Uint8Array` instance, which JSON transport can't produce — the endpoint is non-functional today and is slated for rework in the assets/media system task. When it's reworked, use base64 string data in JSON, or raw `ArrayBuffer`/`Blob` bodies hashed with `computeContentSha256HexFromBytes` — never `FormData`, which would 403 behind this OAC shape.)

## Environments

CanopyCMS handles one deployment. Instantiate the CDK stack multiple times for different environments:

```typescript
// Testing CMS (sandbox account)
new CmsStack(app, 'CmsTest', {
  env: { account: '111111111111', region: 'us-east-1' },
  deploymentName: 'test',
})

// Production CMS (official account)
new CmsStack(app, 'CmsProd', {
  env: { account: '222222222222', region: 'us-east-1' },
  deploymentName: 'prod',
})
```

Separate AWS accounts mean these two stacks' settings branches would never collide even without `deploymentName` — but set distinct values anyway: it's the same repo's `canopycms-settings-*` branch namespace on GitHub, and a future stack sharing an account (or repo) with either of these should not have to guess that the convention exists. See [Two deployments, one repository](#two-deployments-one-repository).

The generated workflow deploys one stack by name, so adding a second one here means updating its Deploy step too — either naming both (`npx cdk deploy CmsTest CmsProd`) or, more usually, giving each environment its own workflow with its own trigger and its own OIDC role.

### Cross-account asset bucket

A supported topology, and the normal one once assets are shared across per-environment accounts: the **asset bucket lives in one account** (a build account, so a promoted build's `/assets/{hash32}/…` references keep resolving as it moves between tiers) while the **compute is per tier, in the tier's own account**.

The grant this needs has two halves. The identity half goes in the compute's stack. The **resource-policy half must be written in the bucket's own stack**, and it needs the Lambda's principal as a **plain string**.

**Do not reach for the construct reference.** `assetSupport.transformFunction.role` and `service.lambdaFunction.role` both work within one account, but across an account boundary CDK emits `Fn::GetStackOutput` — a CDK-CLI-only intrinsic, resolved at deploy time by assuming a publishing role and calling DescribeStacks. Nothing in the emitted CloudFormation records the dependency, and no deploy path other than `cdk deploy` can resolve it. Unlike a same-account circular dependency, it does not fail synth.

Name the roles instead, and pass them in:

```typescript
// Tier stack, in the tier account.
const cmsRoleName = `canopy-cms-${tier}`
const cmsRole = new iam.Role(this, 'CmsRole', {
  roleName: cmsRoleName,
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
})

new CanopyCmsService(this, 'Cms', {
  // ...
  lambdaRole: cmsRole,
  assetBucket: s3.Bucket.fromBucketName(this, 'Assets', assetBucketName),
})
```

```typescript
// Bucket stack, in the build account. No reference, no import - literals only.
bucket.addToResourcePolicy(
  new iam.PolicyStatement({
    principals: [new iam.ArnPrincipal(`arn:aws:iam::${tierAccount}:role/canopy-cms-${tier}`)],
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [`${bucket.bucketArn}/assets/*`],
  }),
)
```

`AssetSupport` takes the same prop for its transform Lambda, as `transformRole`. Both props are `iam.Role` rather than `iam.IRole`, and both cause the construct to re-attach the execution-role managed policies CDK silently drops for a caller-supplied role — including the VPC-ENI policy the CMS Lambda cannot start without. See the [#42 migration entry](adopter-migration.md#assetsupport-and-canopycmsservice-take-an-execution-role-so-its-arn-is-derivable-without-a-construct-reference-42) for both, and for why passing `Role.fromRoleArn` is the one thing to avoid.

Two consequences of naming a role: the tier stack needs **`CAPABILITY_NAMED_IAM`**, and a customer-named IAM role **cannot be replaced in place** without a rename — so pick names you can live with for the life of the deployment.

If you are not ready to wire the narrow version, scoping the bucket policy to the tier **account** rather than the role is a bounded, reversible interim step: coarser, since any principal in that account can then reach the asset prefixes, but easy to tighten later without touching the compute.

## Troubleshooting

**Lambda cold start is slow**: Consider adding provisioned concurrency (1 instance, ~$15/month).

**Tasks stuck in pending**: Check if the EC2 worker is running. First look at its
CloudWatch log group (`/canopycms/<stackName>/worker` — see
[Worker observability](#worker-observability)); no shell access needed. If you can
shell in (SSM or SSH), `systemctl status canopy-worker` on the EC2 instance also
works.

**Auth cache empty**: Run `npx canopycms worker run-once` to populate, or wait for the EC2 worker's 15-minute refresh cycle.

**Preview not rendering**: Make sure your page components use `useCanopyPreview` and the CMS Lambda has the same React components as the public site (same app, two builds).

**Stranded edits on the base branch** (editor saves made directly on `main` before
base-branch protection existed, or via any future bypass): the base clone on EFS has
uncommitted changes that will never reach a PR. Symptoms: worker logs show
`Base branch workspace (<base>) has uncommitted changes -- skipping refresh. Dirty
files: ...` on every sync — the base workspace stops tracking origin until cleaned.
Recovery:

1. Reach the EFS mount (SSM/SSH into the worker EC2, or any shell with the
   filesystem) and go to `{workspaceRoot}/content-branches/{baseBranch}`.
2. Inspect what's stranded: `git status`, and `git log origin/<base>..<base>` for
   stranded local commits.
3. In the editor, create a rescue branch (it forks from the origin base). Copy the
   stranded `content/` changes from the base clone into the rescue branch's clone
   directory (or, from the base clone, `git checkout -b rescue && git push` and
   delete the local ref afterwards).
4. Only after confirming the rescue branch holds the edits, reset the base clone:
   `git checkout <base> && git reset --hard origin/<base>`, plus `git clean -fd`
   for untracked strays. The worker's base refresh resumes fast-forwarding
   automatically on the next sync cycle.
5. If the base branch's `.canopy-meta/branch.json` was left in
   `status: "submitted"` / `syncStatus: "sync-failed"` (from a pre-protection
   submit attempt), set `status` back to `"editing"` and remove `syncStatus` — or
   have an admin use **Withdraw** in the editor, which is deliberately still
   allowed on the protected base branch as the recovery path. `mark-merged` is not
   a cleanup option here: it requires a recorded PR number, which a failed base
   submit never produced.
6. Submit the rescue branch through the normal flow.
