# RESOLVED — Full CMS-service deployment test (its own epic)

**Done 2026-07-24** on integration branch `epic/deployment-test`. The entire
CanopyCMS prod-mode stack was deployed to the sandbox account (905418271997 /
us-east-1, `canopy` bootstrap) for the first time and exercised end-to-end against
real AWS + real Clerk. Original kickoff prompt preserved at the bottom.

## Outcome: it works end-to-end — after 13 PRs of fixes

Everything the kickoff asked to prove was proven on the live deployment
(CloudFront `https://d1rxq1tjvketcw.cloudfront.net`). None of it worked on the first
try; the value of the test was the defect list below.

### Verified on the live deploy (verification matrix)

1. **Editor from the deployed Lambda** — renders behind CloudFront with a real Clerk
   session; direct Function URL returns 403 (OAC enforced).
2. **Branch create → EFS clone** — `feature-deploy-test-edit` provisioned on EFS,
   Owner = the signed-in Clerk `user_…` id. Proves the whole auth chain: Clerk →
   networkless JWT verification on the internet-less Lambda → path/branch ACL
   ownership. ~79 MB EFS clone burst observed.
3. **Edit + save (no commit)** — saved to the branch working tree.
4. **Image upload + transform** — full pipeline: presign (Lambda → S3 via the VPC
   gateway endpoint) → direct browser S3 POST → finalize (sniff/hash/dims/meta) →
   CloudFront `/assets/t/{dirs}/{hash}/{slug}.{ext}` cold=200 WebP `Miss` → warm
   `Hit`, output persisted to `assets/t/`. The **OAC-signed transform Lambda as an
   origin-group failover leg** — the one thing the assets-epic spike could not prove
   — is now confirmed. MediaLibrary picker works from the deployed editor.
5. **Submit → worker → bot PR** — the never-before-run path: the Lambda committed +
   pushed to EFS `remote.git` + enqueued a task; the EC2 spot worker pushed the
   branch to GitHub and opened **PR #1**, commit authored `CanopyCMS Bot
   <canopycms-bot@users.noreply.github.com>`, diff exactly the edit.
6. **Status sync** — the worker wrote the PR number/URL back to branch metadata /
   `branches.json` (editor shows a "PR #1" badge + View-PR link after the sync
   cycle). Merged PR #1 via `gh` (JP delegated); the static build off merged `main`
   reflects the change. **Two gaps found — see below.**
7. **Live preview** — title + uploaded image render live in the preview pane.
8. **Worker/Lambda logs** — Lambda + transform-Lambda log to CloudWatch; the worker
   was observed via EC2 console output + EFS CloudWatch metrics (SSM unavailable —
   see gaps).
9. **Static rebuild** — `CANOPY_BUILD=static` build of merged `main` contains the
   edited title in `out/index.html`.

## Fixes required to get there (13 PRs, all on `epic/deployment-test`)

Pre-deploy design review, dogfooding, template review, and the live deploy each
caught defects unit tests could not:

**Packaging / CLI**
- #128 `canopycms-cdk` `prepack` builds the worker + transform-Lambda bundles — the
  published package (every version ≤0.0.58) shipped without them and could not synth.
- #135 published `bin` shipped a `tsx` shebang → `npx canopycms` was broken for every
  adopter; postbuild now strips/bundles `cli.js` + guards against non-node shebangs.
- #133 `init --auth clerk --dual-build` non-interactive flags (scriptable scaffolding).

**CanopyCmsService construct**
- #129 **EFS path split-brain** (Lambda `/mnt/efs/workspace` via a `/workspace`-rooted
  access point resolved to `EFS:/workspace/workspace` while the worker used
  `EFS:/workspace`) — every cross-component flow was dead; plus `architecture` prop,
  SSM policy, EFS mount-target boot ordering, worker `AWS_REGION` crash-loop fix,
  and a (later-superseded) `GIT_CONFIG_*` env attempt.
- #138 worker ESM bundle crash-looped under Node 20 (`.js` treated as CJS) → write
  `{"type":"module"}` next to the bundle; install `unzip` explicitly.
- #140 **git env + safe.directory** — simple-git's `.env()` *replaces* the child env
  (so runtime git vars vanished) AND it hard-blocks env-based git config; fixed with
  an env allowlist + `git config --system safe.directory '*'` in the image. This was
  the live "dubious ownership" failure on the first authenticated branch action.

**Docker template**
- #130 wrong LWA image repo name (`aws-lambda-web-adapter` doesn't exist →
  `aws-lambda-adapter`); `clerkMiddleware` needs an explicit `jwtKey` (the env var is
  never read → the no-internet Lambda would hang on sign-in); publishable-key build
  ARG; `.dockerignore` generation; `.next/cache` → /tmp.
- #136 build-time content reads must run in **dev** mode (prod reads need an EFS
  workspace that can't exist in the builder) and need a git repo (excluded by
  `.dockerignore`) → builder synthesizes a single-commit repo.

**CloudFront**
- #134 `CanopyCmsDistribution` cache policy would be rejected at deploy (Authorization
  header at TTL 0) + `/assets/*`-before-`/assets/t/*` behavior ordering doc fix.
- #139 replace the custom TTL-0 cache policy with the managed `CACHING_DISABLED` —
  CloudFront rejects ANY non-none cache-key setting (including cookies/query-strings
  `all()`) when caching is disabled. (Found on the first live deploy attempt.)

**Guards (JP-requested, adopter protection)**
- #131 empty-remote guard: `ensureRemoteGit` verifies the base branch exists after
  clone, self-heals (delete + retry) on an empty repo, releases the worker lock on
  failure.
- #132 prod network-remote guard: `resolveRemoteUrl` rejects network `defaultRemoteUrl`
  / `CANOPYCMS_REMOTE_URL` in prod (with `allowNetworkRemoteInProd` escape hatch).
- #137 transform Lambda runtime `nodejs20.x` → `nodejs22.x` (deprecated; failed synth).

**Test-repo-local (not package):** infra/ fully dockerignored (Next build typecheck
swept the CDK app); CDK `generateLaunchTemplateInsteadOfLaunchConfig` feature flag
(this account can't create LaunchConfigurations); CloudFront Function may not set
`x-forwarded-proto` (disallowed header → 502) — only `x-forwarded-host`.

## What the first real customer deploy still needs (open follow-ups)

- **[post-merge-sync-gaps](post-merge-sync-gaps.md)** (P1) — after a content PR merges, the branch stays
  "submitted" (no auto merge-detection) and the editor's base-branch (`main`)
  workspace clone is stale, so editors see old content and fork new branches from
  stale main. Core to the multi-editor workflow.
- **CloudWatch log shipping for the worker (now REQUIRED, not optional)** — the human
  SSO role (`SafeInsights-DevAdmin`) cannot `ssm:StartSession`/`SendCommand`, so the
  worker was a black box observable only via EC2 console output + EFS metrics. A real
  deploy needs the worker's journald shipped to CloudWatch (add the agent in
  user-data, or grant SSM to the operating role). (resolved — see
  [worker-cloudwatch-logs.md](worker-cloudwatch-logs.md))
- **[server-mode-anonymous-read-500](server-mode-anonymous-read-500.md)** + **[slug-route-nofallback-500](slug-route-nofallback-500.md)** (P2) —
  content-read edge cases surface as 500 on the server build.
- **[canopycms-pack-needs-prepack](canopycms-pack-needs-prepack.md)** (P2) — `canopycms` and siblings need the same
  `prepack` guard `canopycms-cdk` got, so a local pack never ships stale `dist/`.
- **Bot credentials** — the test used a fine-grained PAT scoped to the one repo
  (Contents + PR RW). GraphQL draft-conversion (withdraw/request-changes) was not
  exercised and is the known fine-grained-PAT risk; a real deploy should use a
  dedicated machine account. `middleware.ts` freezes auth mode at init (documented
  footgun). (`deploying-to-aws.md`'s `fromSecretNameV2` partial-ARN trap was fixed in
  this epic's docs pass.)
- **Minor:** finalize accepts a PNG the transform Lambda's libpng rejects (broken
  thumbnail, clean 422); "TODO: replace with real modified file list" placeholder
  visible in the All-Files menu.

## Operational facts for the next deploy (harness kept)

- Reusable harness kept per JP: GitHub repo **canopycms/deploy-test** (private), the
  Clerk dev instance (`coherent-stag-63`), the local test repo
  `~/dev/safeinsights/canopy-deploy-test` (+ its `infra/` CDK app). Re-deploy: fill
  `infra/deploy-config.ts` ARNs, `.env.local` Clerk keys, `aws sso login --profile
  sandbox-admin`, `npx cdk deploy` (two-pass: then `-c editorOrigin=https://<cf>`).
- Deploy is two-pass (placeholder editorOrigin → read DistributionDomainName →
  redeploy with it for bucket CORS + `CLERK_AUTHORIZED_PARTIES`).
- Transform URL format: `/assets/t/f=webp,w=160/<hash>/<slug>.<ext>` (directives
  FIRST; width a multiple of 160).
- Secrets (JP-created): `canopy-cms-deploy-test/github-token`,
  `.../clerk-secret-key` — worker-only; Lambda holds only `CLERK_JWT_KEY` (public).
- Stack `canopy-cms-deploy-test`; teardown = `npx cdk destroy` (EFS + asset bucket set
  DESTROY/autoDelete); then sweep `/aws/lambda/canopy-cms-deploy-test*` log groups.

---

_Original kickoff prompt (preserved):_ first full prod-mode AWS deploy — editor
Lambda, EFS, EC2 worker, Clerk, publish/PR flow; scaffold a fresh `canopycms init`
repo; include AssetSupport; deploy via the `canopy` bootstrap exec role; exercise
every path; tear down + write up. All satisfied above.
