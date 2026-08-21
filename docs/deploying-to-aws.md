# Deploying CanopyCMS to AWS

This guide walks through deploying CanopyCMS on AWS using Lambda + EFS + EC2 Worker. This architecture costs ~$5-9/month and is designed for low-traffic CMS editing workflows.

> **Deploy-proven notes (2026-07).** The whole stack was first deployed and
> exercised end-to-end during the deployment-test epic — see
> [`.claude/future-tasks/resolved/cms-service-deployment-test.md`](../.claude/future-tasks/resolved/cms-service-deployment-test.md)
> for the full account of what broke and the fixes. Load-bearing gotchas that
> guide is the source of truth for: reference secrets by their **full** ARN
> (below); Lambda **architecture must match the Docker image platform**;
> **`clerkMiddleware` needs an explicit `jwtKey`** (the env var alone is never
> read → the no-internet Lambda hangs on sign-in) and the shipped template
> asserts a secret key; the raw-CloudFront path needs the managed
> `CACHING_DISABLED` policy and an `x-forwarded-host`-only CloudFront Function;
> and a two-pass deploy for bucket CORS + `CLERK_AUTHORIZED_PARTIES`. The
> EC2 worker's logs now ship to CloudWatch by default (see
> [Worker observability](#worker-observability) below) — a locked-down
> operator role may not have SSM, and the worker was otherwise unobservable.
> Adopters consume the published `canopycms-cdk` package; the constructs
> referenced here also power `AssetSupport` for media (add it to give the
> deployed editor an upload/transform backend).

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
- Node.js 22+
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
- `.dockerignore` — keeps `.env*` out of the build context
- `.github/workflows/deploy-cms.yml` — CI/CD workflow
- `cdk.json` — CDK app configuration; `cdk deploy` resolves the app through this
- `infrastructure/bin/app.ts` — CDK app entry point
- `infrastructure/lib/cms-stack.ts` — the stack itself, yours to edit

The install and build commands in `Dockerfile.cms` and the workflow are written
for the package manager the command detects (npm, pnpm, or Yarn — from your
`packageManager` field, else your lockfile). The deploy trigger branch comes
from `origin/HEAD`, and the worker's repo from your `origin` remote.

`init-deploy aws` never overwrites a file you already have — re-run it with
`--force` to replace them.

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
deployment image, and the deployed server — and the first two genuinely need
dev: a prod-mode build read looks for a branch workspace on EFS that cannot
exist in an image builder, so a `mode: 'prod'` literal fails the image build.

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
you hand-edit the stack or the Dockerfile. Two things to know if you do:

- `environment: { CANOPY_MODE: ... }` on `CanopyCmsService` accepts only
  `'prod'`, and rejects anything else at synth.
- If you build the image yourself, pass
  `--build-arg NEXT_PUBLIC_CANOPY_MODE=prod`. Without it the deployed editor
  believes it is in dev mode: it sends dev-auth headers at a server enforcing
  Clerk (every editor call rejected) and hides the pull-request UI.

## Step 4: CDK Stack

Step 2 scaffolded the CDK app. Install what it needs to run:

```bash
npm install --save-dev canopycms-cdk aws-cdk-lib constructs tsx aws-cdk
```

All five are load-bearing: `cdk.json` runs
`node --import tsx infrastructure/bin/app.ts`, which imports the first three,
and pinning `aws-cdk` keeps the deploying CLI version reproducible instead of
whatever `npx` fetches that day. The generated workflow checks for them before
deploying, so a missing one fails with a named error rather than an
`ERR_MODULE_NOT_FOUND` several minutes into `cdk deploy`.

### What to fill in

`infrastructure/bin/app.ts` reads its configuration from the environment so the
same file works locally and in CI. The generated file marks each one; the ones
without a default refuse to synth when unset, deliberately — every one of them
has a silent-failure mode that is far more expensive to diagnose after a
successful deploy.

| Variable                                     | Required | Notes                                                                                                                                                                                |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_TOKEN_SECRET_ARN`                    | yes      | **Full** ARN including the six-character suffix — it goes verbatim into the worker's IAM policy, so a name-based ARN silently never matches and the worker gets AccessDenied at boot |
| `CLERK_SECRET_KEY_SECRET_ARN`                | yes      | Full ARN, same reason                                                                                                                                                                |
| `CLERK_JWT_KEY`                              | yes      | Clerk's public JWKS PEM. Unset, Clerk falls back to a network JWKS fetch and the no-internet Lambda hangs at sign-in                                                                 |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`          | no       | Deploys fine when empty and ships an editor that cannot sign in                                                                                                                      |
| `CANOPY_BOOTSTRAP_ADMIN_IDS`                 | no       | Comma-separated Clerk user IDs granted admin on first boot                                                                                                                           |
| `CANOPYCMS_DEPLOYMENT_NAME`                  | no       | Defaults to `prod`. Two stacks sharing one GitHub repo **must** differ — see [Two deployments, one repository](#two-deployments-one-repository)                                      |
| `CMS_DOMAIN_NAME` / `CMS_HOSTED_ZONE_DOMAIN` | no       | Set both to add CloudFront + Route53; leave unset to use the Lambda Function URL directly                                                                                            |

Then edit `infrastructure/lib/cms-stack.ts` for anything beyond that — memory
and concurrency, `AssetSupport` for media (a commented block in the generated
file), or a distribution you already own.

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
cdk bootstrap                # once per account/region
cdk synth                    # confirm it builds before touching the account
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
3. **A Docker daemon on the runner** (`ubuntu-latest` has one).
4. **The CDK devDependencies from Step 4**, committed to `package.json`. The
   workflow checks for them before deploying.

### Repository secrets and variables

The Deploy step passes these through to `infrastructure/bin/app.ts`. The
required ones are read by `required()` there, so a missing value fails the
deploy at synth — before anything is changed in the account.

| Name                                        | Kind      | Required                                     |
| ------------------------------------------- | --------- | -------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`                       | secret    | yes                                          |
| `CANOPY_GITHUB_TOKEN_SECRET_ARN`            | secret    | yes (see note below)                         |
| `CLERK_SECRET_KEY_SECRET_ARN`               | secret    | yes                                          |
| `CLERK_JWT_KEY`                             | secret    | yes                                          |
| `AWS_REGION`                                | variable  | yes                                          |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`         | variable  | no, but the editor cannot sign in without it |
| `CANOPY_BOOTSTRAP_ADMIN_IDS`                | variable  | no                                           |
| `CANOPYCMS_DEPLOYMENT_NAME`                 | variable  | no (defaults to `prod`)                      |
| `CMS_DOMAIN_NAME`, `CMS_HOSTED_ZONE_DOMAIN` | variables | no (enables CloudFront + Route53)            |

> **Why `CANOPY_GITHUB_TOKEN_SECRET_ARN` and not `GITHUB_TOKEN_SECRET_ARN`?** GitHub
> reserves the `GITHUB_` prefix and rejects any Actions secret or variable whose name
> starts with it, so the obvious name cannot be created. The generated workflow maps this
> secret onto an unprefixed `GITHUB_TOKEN_SECRET_ARN` environment variable, which is what
> the CDK app reads — only the _secret_ name needs the prefix.

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

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is inlined into the **client** bundle by
Next.js at image-build time, so it has to reach the image _build_ — a Lambda
environment variable is far too late. Because CDK builds the image, it must be
passed through `buildArgs` in the stack, not through a `docker build
--build-arg` step in CI:

```ts
cmsDockerImage: lambda.DockerImageCode.fromImageAsset('.', {
  file: 'Dockerfile.cms',
  buildArgs: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
  },
}),
```

The workflow sets that variable on the `cdk deploy` step from a repository
variable. If it is missing, the deploy still succeeds and the editor ships with
an empty publishable key.

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

The Lambda does NOT need these secrets — only the EC2 worker reads them.

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
- **Timestamps**: log events carry ingestion timestamps (the worker doesn't emit
  its own yet — see
  [`.claude/future-tasks/worker-log-timestamps.md`](../.claude/future-tasks/worker-log-timestamps.md)).
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

| Lambda                           | EC2 Worker                                      |
| -------------------------------- | ----------------------------------------------- |
| No internet access               | Outbound HTTPS only                             |
| No sensitive secrets             | GitHub token + Clerk key (from Secrets Manager) |
| Public keys only (CLERK_JWT_KEY) | Full API access                                 |
| Read/write EFS only              | Read/write EFS + internet                       |

If Lambda is compromised, an attacker can read/write content on EFS but cannot exfiltrate data, push to GitHub, or access any external service.

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
