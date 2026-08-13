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

#### 11. Does a refused `--force-with-lease` leave the loser's ref untouched? (EFS/NFS)

**A verification D must run, not a suspected bug.** PR #198 has the production
worker force-push rewritten history into `remote.git` under `--force-with-lease`.
The code may well be correct; the point is that nobody can currently *prove* it,
and this is the assumption a mistake destroys editors' committed work through.
Recorded here rather than left as a resolved "probably fine", because Workstream
D is the only place a real EFS mount and a real Lambda exist together.

**This is not really about #198 — but be careful about *why*.** The tempting
argument is that the primitive underneath is the same one
[concurrency.md](../../docs/concurrency.md)'s Layer 3 ("Server-enforced lock",
`proper-lockfile`) already bets the settings and metadata design on, so a failure
would break far more than the worker. That argument is **half right, and it
overclaims in the direction that matters.** It was made and then withdrawn by
#198's own session; the corrected version is below, because getting it wrong
would license a green soak to certify things it never touched.

**There are three distinct exclusive-create primitives in play, not one:**

| Primitive         | Where                                                                        | In the doc's stated foundation?             |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| `link()`          | `utils/occ-json-write.ts` — new-file creation (Layer 2)                       | **Yes**                                     |
| `mkdir`           | `proper-lockfile` — `withOccFileLock`, `acquireProvisioningLock` (Layer 3)    | **Yes**                                     |
| `O_CREAT\|O_EXCL` | git's ref lockfile (the worker's force-push)                                  | **No**                                      |

concurrency.md's preamble names only two: "`link()`/`mkdir` fail with EEXIST
**enforced by the server**, immune to client caching". `O_CREAT|O_EXCL` is absent
from that list, and Layer 2 actively steers away from Node's equivalent ("never
`writeFile({flag:'wx'})`, which can leave a partial file") — for crash semantics
rather than atomicity, but the effect is that **nobody in this repo ever
deliberately bet on that primitive.** So the worker's force-push inherits
*nothing* from Layer 3 being sound.

**The historical direction runs the same way.** `mkdir` and `link()` are the
traditionally trusted NFS lock primitives *precisely because* `O_CREAT|O_EXCL`
was unreliable on NFSv2/v3 — mkdir-based locking exists as the portable
workaround for exactly that. NFSv4's EXCLUSIVE4/GUARDED4 create modes are meant
to have fixed it, and there is no particular reason to think EFS is broken. But
that makes git's path **the one most deserving of the soak**, not the one covered
by inheritance.

**What survives, and it is still the reason to run this:** all three rely on the
NFS *server* enforcing exclusive-create-by-name, which is a coherent guarantee
class. A failure here would most likely be a server-side exclusive-create
failure, and that *would* implicate the whole class. But **a green result on one
member certifies only that member** — and the inference is directional:

- A green **git / `O_CREAT|O_EXCL`** soak says nothing about `mkdir` or `link()`.
- A green **`mkdir`** result says nothing about git's path, and is the **weaker**
  inference of the two, since `mkdir` is the historically safer primitive.

So: cover all three, or record explicitly which member was exercised and that the
rest is being generalized. A few `mkdir`- and `link()`-contention iterations
alongside the push soak close it outright and are cheap next to the soak itself.

**Two uncatalogued `O_CREAT|O_EXCL` dependencies already exist in the repo**, so
the git-path soak is also their first real coverage:

- `settings-workspace.ts` — a bespoke init lock (doc comment: "Uses
  O_CREAT|O_EXCL (wx flag) for atomic file creation") which concurrency.md itself
  flags as "**not one of the four numbered layers above** … not yet cataloged".
  It is what stops two hosts both deciding it is safe to run `checkout --orphan`
  + `rm -rf .` on a populated workspace — a sequence the doc calls **not
  recoverable**.
- `assets/store-local.ts` — `putMetaIfAbsent` writes with `{ flag: 'wx' }`. See
  [asset-meta-wx-vs-link.md](asset-meta-wx-vs-link.md).

Cataloguing the `settings-workspace.ts` pair in concurrency.md's table is worth
doing while D is in this area — an undocumented dependency guarding an
unrecoverable operation is exactly what the table exists to surface.

**What is already settled — do not re-litigate it.** The real compare-and-swap is
**not** the client-side lease. For *every* push, forced or not, the client sends
`<old> <new> <ref>` and `git-receive-pack` re-verifies `<old>` under the per-ref
lockfile before committing the update. A concurrent push that moves the ref
between advertisement and commit therefore yields a **refused** update, not a
lost one. #198's adversarial reviewer partially confirmed this locally: a
mid-push ref move was forbidden by git's quarantine machinery rather than racing
through. Confidence is **high** on git's mechanism and **moderate-high** on EFS
honoring it — the residual is entirely "does EFS behave like a correct NFS
server here", which is exactly what a real mount settles.

**State the property precisely.** It is not "does `--force-with-lease` work" —
that phrasing invites a test that passes trivially. It is:

> A lease refused by a concurrent push leaves the loser's ref untouched: two
> concurrent writers to the same `refs/heads/<branch>` in the shared bare repo,
> one leased and one plain, end with the ref holding **exactly one** of the two
> histories, never a torn or partially-updated state, and the refused writer gets
> an **error** rather than a silent no-op.

**Soak design** (#198's reviewer's, preferred over a single two-writer race):

- Instance A loops **plain** pushes advancing a ref in the shared bare repo.
- Instance B loops **`--force-with-lease`** pushes against sampled expected values.
- Run for **hours** under real EFS with the stack's actual mount options.
- Assert afterwards that (a) **every acknowledged push remains reachable** — this
  is the assertion that would catch a lost update — and (b) `git fsck` is clean.

**Two runbook details:**

1. **Use the mount options the stack actually uses.** The doubt is not the
   lockfile primitive but whether anything else in the path weakens it —
   specifically **`packed-refs` rewriting under contention**, which is a
   different code path from the loose-ref lockfile and is the first place to look
   if the soak ever shows a discrepancy.
2. **Pin the git version and record it.** The lease/rejection *stderr* text is
   version- and locale-sensitive — the worker already depends on `LC_ALL=C` for
   its `(stale info)` classifier — so a git bump on the AMI could change
   classification behaviour independently of the atomicity question, and would
   look like an atomicity regression if the version were not recorded.

Relevant code: `forcePublishToLocalRemote` and `pushBranchToGitHub` in
`packages/canopycms/src/worker/cms-worker.ts`, plus the `remote.git` refs row
#198 adds to [concurrency.md](../../docs/concurrency.md) describing the intended
invariant.

If it holds, record it in [program-log.md](program-log.md) — it retires a
standing unknown behind the worker's whole publish path *and* behind Layer 3. If
it does not, it is a production data-loss bug that outranks the rest of this
workstream.

### 5. Run it with an agent

Every failure becomes a Canopy fix, then re-run until clean.

## Verification

The suite passes against the rebuilt sandbox stack from a cold `cdk deploy`.

## Definition of done

A repeatable command that proves a Canopy deployment is healthy — reused in E
against the docs-site deployment, and handed to the team in G as the standing
smoke test.
