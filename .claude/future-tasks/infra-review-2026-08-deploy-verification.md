# [P2] Post-deploy checklist for the 2026-08 infra-review fixes

Filed 2026-08-21 by the `epic/infra-review-2026-08` epic, at JP's request
("there will be deploys soon, make sure we remember to check what we need to
later").

Several fixes in that epic are **inert until a `cdk deploy`**, and two of them
fail *silently* if the deploy does not take — which is exactly how the defects
they fix went unnoticed in the first place. Run this against the first prod
deploy that carries the epic. Close this file once it has been run once
successfully.

## 1. Auth cache — the one that is invisible unless you look

The highest-certainty defect in the review: the worker wrote the `current`
symlink with an ABSOLUTE target, meaningless across the worker's and Lambda's
different EFS mount paths, so the Lambda served a permanently empty auth cache
on every prod deploy with Clerk.

- [ ] On the worker (SSM session): `ls -l /mnt/efs/workspace/.cache/current` —
      the target must be a **bare `snapshot-<ts>`**, not an absolute path.
- [ ] In the editor UI: an editor renders with their **name and avatar**, not a
      raw `user_...` Clerk id. This is the end-to-end proof.
- [ ] A path or branch ACL granted to a **Clerk organization** actually grants.
      Before the fix it silently denied.
- [ ] The admin permission-assignment UI can find users and orgs.

Note the failure mode is fail-CLOSED and degraded rather than broken, which is
why nobody noticed for so long. Do not skip the second and third checks just
because the symlink looks right.

## 2. Worker boot — Node 22 and fail-fast

The worker previously installed Node **20** (EOL 2026-04-30) from a piped
third-party installer, and a failed boot script left an instance that ran,
passed EC2 health checks forever, and did nothing.

- [ ] The replacement instance comes up and `systemctl status canopy-worker` is
      active, running `/usr/bin/node-22`.
- [ ] `node-22 --version` on the instance reports v22.x.
- [ ] Worker logs reach CloudWatch (the agent is installed after worker start,
      so its failure must not have blocked the worker).
- [ ] The admin panel shows the worker **present**, and a publish completes end
      to end.
- [ ] Confirm the ASG actually replaces a broken boot. Safest way: watch the
      rolling replacement this deploy performs anyway and check no instance is
      left running without the systemd unit. Deliberately breaking user-data to
      test the trap is NOT recommended against a live stack.

## 3. CloudFront origin timeout

- [ ] An operation that legitimately takes >30s — first-touch provisioning of a
      branch on a large repo is the reliable one — **completes** instead of
      returning 504 at the edge while succeeding server-side.
- [ ] In the distribution config, the Function URL origin shows
      `OriginReadTimeout: 60`.

## 4. Transform Lambda limits

- [ ] The transform function shows a **reserved concurrency** of 10.
- [ ] `GET /assets/t/w=160/<real-hash32>/wrong-slug.webp` returns **404** and
      writes **no** new object under `assets/t/`.
- [ ] The same URL with the asset's real slug still returns the image.
- [ ] The bucket carries the `expire-transform-outputs` lifecycle rule on
      `assets/t/` (180 days), and NO rule touching `asset-originals/` or
      `asset-meta/`.

## 5. IAM secrets

- [ ] The worker reads its secrets with **no AccessDenied** in its log stream.
      (The grant is now the union of `secretsArns` and the individual ARN
      props, so a stack setting only the latter should now work.)

## 6. Release pipeline (no deploy needed, but verify on the next release)

- [ ] The next push to main shows publish.yml **waiting** on the "Wait for CI to
      pass on this commit" step, then publishing.
- [ ] A prerelease via `workflow_dispatch` still publishes **immediately** (it
      routes to the `prerelease` job and must not hit the gate).
- [ ] The published version is one patch above whatever `npm view canopycms
      version` reported before the run.

## If something here fails

The relevant resolved task files carry the full analysis:
[auth cache](resolved/infra-review-2026-08-auth-cache-symlink.md),
[worker boot and secrets](resolved/infra-review-2026-08-worker-boot-and-secrets.md),
[CloudFront timeout](resolved/infra-review-2026-08-cloudfront-origin-timeout.md),
[transform abuse](resolved/infra-review-2026-08-transform-lambda-abuse.md),
[release pipeline](resolved/infra-review-2026-08-release-pipeline.md).
