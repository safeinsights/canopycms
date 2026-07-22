# Future Task / Kickoff Prompt: Full CMS-service deployment test (its own epic)

Status: **ready to run** — this is JP's stated next-priority big effort. Distinct from the
assets epic; the assets epic only *unblocked* it by fixing `CanopyCmsService`'s S3
reachability. Nothing here has ever been deployed: the editor Lambda, EFS, and the EC2
spot worker were written months ago and never exercised against real AWS.

## Goal

Stand up the ENTIRE CanopyCMS prod-mode deployment in the sandbox account and exercise
every moving part end-to-end — the parts unit tests and the assets canary could not cover:
the editor running as a deployed Lambda (not `next dev`), branch clones on EFS, the
CmsWorker daemon on its EC2 spot instance, real Clerk auth, and the save→publish→PR flow
with bot pushes. "Test all the things."

## What already exists (read before planning)

- `packages/canopycms-cdk/src/constructs/` — `CanopyCmsService` (Lambda + EFS + worker;
  now with the S3 gateway endpoint + egress fix from the assets epic, PR #125),
  `cms-distribution.ts`, plus the assets `AssetSupport` construct (reuse it — standalone
  mode — so the deployed editor has a real media backend).
- `ARCHITECTURE.md#deployment-architecture` and `docs/deploying-to-aws.md` — the intended
  prod shape (Lambda via Function URL, no internet; EC2 t4g.nano spot worker; EFS; no NAT).
- `packages/canopycms-auth-clerk/` — the Clerk auth plugin (prod mode REJECTS the dev-auth
  plugin by design, so a real Clerk instance is required).
- The sandbox account (905418271997/us-east-1) has a healthy CDK bootstrap under qualifier
  **`canopy`** (stack `CDKToolkit-canopy`). The default-qualifier `CDKToolkit` may or may
  not be repaired by then — check; use `canopy` if unsure.

## Kickoff prompt (paste into a fresh session)

> I want to test the full CanopyCMS prod-mode AWS deployment for the first time — the
> editor Lambda, EFS branch clones, the EC2 spot worker/daemon, real Clerk auth, and the
> save/publish/PR flow. None of this has ever been deployed. Plan it as an epic:
>
> 1. **Scout first**: read `CanopyCmsService` + all `canopycms-cdk` constructs,
>    `ARCHITECTURE.md#deployment-architecture`, `docs/deploying-to-aws.md`, the worker
>    (`worker/` in canopycms), and the Clerk auth plugin. Produce a deployment topology
>    map and a gap list (what's wired vs. what a first real deploy will be missing).
> 2. **Adversarially review** the deploy design against the real constructs before
>    deploying anything (the assets epic's pre-implementation review caught 3 blockers
>    this way — e.g. the VPC had no S3 endpoint at all).
> 3. **Test app**: scaffold a NEW minimal site repo via `canopycms init` (dogfoods the
>    adopter path and gives the publish flow a clean git remote for bot pushes/PRs) rather
>    than deploying the monorepo's `apps/example1`. I'll create the empty GitHub repo and
>    the sandbox secrets when you tell me what's needed.
> 4. **Auth**: set up a Clerk test instance (I'll do the Clerk dashboard steps; you give me
>    the exact config + which env vars/secrets go where).
> 5. **Deploy** to the sandbox via the `canopy`-qualified bootstrap (`aws cloudformation
>    deploy --role-arn <the canopy cfn-exec-role>` or `cdk deploy` — the human DevAdmin SSO
>    role cannot create distributions/OACs directly; everything goes through the exec
>    role, as the assets canary did). Include `AssetSupport` so the editor has a media
>    backend.
> 6. **Exercise every path** and show me proof of each: editor loads from the deployed
>    Lambda; create a branch → EFS clone provisions; edit + save (writes to the branch
>    clone, no commit); upload an image (presigned → S3 → transform served via CloudFront);
>    publish → worker commits + pushes via bot + opens a PR; branch status updates; a
>    static rebuild reflects the published change. Watch the worker's CloudWatch logs.
> 7. **Tear down** (or hand me the teardown) and write up what worked, what was missing,
>    and what the real first-customer deploy will need.
>
> Ground rules: I log into AWS SSO myself (`aws sso login --profile sandbox-admin`); you
> use the cached session, never touch `~/.aws` secrets, no `--debug`, no credential-export
> subcommands. Do NOT touch the `docs-site-proto` sandbox stacks — they're serving as a
> real deploy until its production deploy lands. Namespace everything you create.

## Decisions to settle at kickoff

- Test-app repo: new `canopycms init` repo (recommended) vs. deploying `example1`.
- Clerk: test instance (required for prod mode) — who does which setup step.
- Whether to also repair/confirm the default-qualifier CDK bootstrap first.
