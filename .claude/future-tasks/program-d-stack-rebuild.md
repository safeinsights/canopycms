# Program D — Rebuild and exercise the deploy-test stack

**Part of:** [production-readiness-program.md](production-readiness-program.md)
**Size:** M · **Status:** not started · **Blocked by:** B1 + B2 · **Blocks:** E

## Purpose

Re-prove the from-scratch adopter path on current code, and convert the one-off
July verification into a reusable artifact. This is the gate before any real-site
deployment.

## Prerequisites

B1 (multi-deployment safety) and B2 (worker ASG update policy, log retention,
deploy CI template) must be merged — otherwise the rebuild re-proves known-broken
things.

## Steps

### 1. Inventory before destroying anything

```bash
aws sso login --profile sandbox-admin
aws cloudformation describe-stacks --profile sandbox-admin --region us-east-1 \
  --query 'Stacks[].{Name:StackName,Status:StackStatus,Created:CreationTime}' --output table
```

The local SSO token was expired at program start, so **live AWS state is unknown**.
Record:

- the `canopy-cms-deploy-test` stack's existence and status
- the `CDKToolkit-canopy` bootstrap stack
- **the `docs-site-proto` stacks sharing account `905418271997` — do not touch these**
- the current `builds/{sha}` behind `dev-docs.sandbox…`, as the rollback point for E

This inventory also resolves open decision #2 (whether testing/production is
serving anything the teams rely on, which determines Canopy's target environment
in E).

### 2. Resolve the dirty working tree and destroy

`~/dev/safeinsights/canopy-deploy-test` has uncommitted split-page
(`page.server.tsx` / `page.static.tsx`) work plus modified vendor tarballs. Commit
or discard deliberately — do not destroy over it.

```bash
cd ~/dev/safeinsights/canopy-deploy-test/infra
npx cdk destroy canopy-cms-deploy-test --profile sandbox-admin
```

Then sweep the `/aws/lambda/canopy-cms-deploy-test*` log groups (they are
auto-created with infinite retention and survive `cdk destroy` — the gap B2
fixes).

### 3. Rebuild from scratch

Rebuild on current packages, **treating `docs/deploying-to-aws.md` as the spec**.
Every place the doc is wrong is a finding, and the point of doing it from zero
rather than updating in place.

Known operational facts from the July deploy, all of which should now be either
fixed or documented:

- Deploy is two-pass: placeholder `editorOrigin` → read `DistributionDomainName`
  → redeploy with `-c editorOrigin=https://<cf-domain>` for bucket CORS and
  `CLERK_AUTHORIZED_PARTIES`.
- Secrets must be referenced by **full ARN** (`fromSecretCompleteArn`) — a
  name-based partial ARN silently never matches and the worker AccessDenies at boot.
- Lambda architecture must match the Docker build platform.
- `clerkMiddleware` needs an explicit `jwtKey`; the env var alone is never read
  and the internet-less Lambda hangs on sign-in.
- CloudFront needs the managed `CACHING_DISABLED` policy, and a CloudFront
  Function may set `x-forwarded-host` but **not** `x-forwarded-proto` (disallowed
  header → 502).
- Transform URL format: `/assets/t/f=webp,w=160/<hash>/<slug>.<ext>` — directives
  first, width a multiple of 160.

**Ride-along:** land [efs-tls-in-transit.md](efs-tls-in-transit.md) as part of this
rebuild. It adds the `tls` option (efs-utils stunnel) to the worker's EFS mount in
both places — the `mount -t efs` bootstrap command and the `/etc/fstab` line in
`canopycms-cdk/src/constructs/cms-service.ts`. It was deferred only because it
changes the deploy-proven mount path and therefore needs its own verification
deploy; this rebuild *is* that deploy, so doing it here costs nothing extra and
avoids a dedicated deploy later. Confirm the mount survives an instance reboot
(the existing `cms-deploy.test.ts` reboot assertion) and that the worker still
reaches its clone after the change.

### 4. Build the deployed-stack verification suite

**This is the main deliverable.** July's verification was a hand-driven 9-row
matrix executed once in a session. Replace it with a checked-in suite runnable
against any deployment URL:

1. sign in through real Clerk
2. create a branch → EFS clone provisioned, owner set
3. edit + save to the branch working tree
4. image upload → presign → S3 → finalize → transform → CloudFront hit
5. submit → worker → bot PR opened on GitHub
6. status sync — PR number/URL written back to branch metadata
7. live preview renders drafts
8. Lambda and worker logs reachable in CloudWatch
9. static rebuild off the merged base contains the edit
10. admin-recovery paths from the git-admin-observability epic

**The hard part is real Clerk auth.** Choose deliberately between a Clerk test
user with programmatic sign-in (fully automated, needs a test-user strategy that
does not weaken the real instance) and a scripted runbook with human checkpoints
(cheaper, not agent-runnable). Record the choice and reasoning in
[program-log.md](program-log.md).

### 5. Run it with an agent

Every failure becomes a Canopy fix, then re-run until clean.

## Verification

The suite passes against the rebuilt sandbox stack from a cold `cdk deploy`.

## Definition of done

A repeatable command that proves a Canopy deployment is healthy — reused in E
against the docs-site deployment, and handed to the team in G as the standing
smoke test.
