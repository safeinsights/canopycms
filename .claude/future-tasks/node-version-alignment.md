# [P3] Node versions are stated in many places and must move together

Owed from the 2026-08 infra-review epic's plan (I said I would file the
repo-wide 22 → 24 bump and did not), plus two inconsistencies the round-4
independent review surfaced. Filed together because they are one decision, not
three.

## Where Node versions are declared today, after the epic

| Place | Value | Set by |
| --- | --- | --- |
| `.nvmrc` | `v22` | pre-existing |
| root `package.json` `engines` (private) | `>=22.12.0` | PR #308 (was `>=22`) |
| **published packages' `engines`** (all five) | **`>=22.12.0`** | PR #308 (was `>=18`) |
| EC2 worker (`cms-service.ts` user-data) | `nodejs22` / `/usr/bin/node-22` | this epic |
| transform Lambda | `NODEJS_22_X` | pre-existing |
| scaffold `Dockerfile.cms.template` + `deploy-cms.yml.template` | `22` | this epic |
| `examples/aws-deployment/deploy-cms.yml` | `22` | round-4 cleanup |
| esbuild `target`s: `canopycms/scripts/postbuild.mjs`, `canopycms-cdk`'s `build:worker` script, `canopycms-cdk/lambda/asset-transform/build.mjs` | `node22` | `chore/actions-node24` (were `node20`; no earlier sweep listed them) |

So the runtimes are now consistent at 22. Not in this table: the runtime each pinned
GitHub Action declares (`runs.using`). That belongs to the action, not to us, and
changes only when the action is re-pinned; see
[resolved/gha-actions-node20-runtime.md](resolved/gha-actions-node20-runtime.md).

**Question (1) below is ANSWERED as of 2026-09-09 (PR #308), which narrowed all five
published packages from `>=18` to `>=22.12.0` and moved the root to match.** It was
not taken as a free cleanup: the packages are ESM-only and reach CommonJS consumers
through `require(esm)`, which Node unflagged in **22.12.0**, so `>=18` was never true
for a CommonJS consumer — it advertised a compatibility that did not exist rather than
one merely untested. `>=22` would have been wrong too, admitting 22.0–22.11 where the
CommonJS path still fails with no engines warning to say so. Question (2) is untouched
and remains the open half of this file.

## The two questions

**1. Should published `engines` say `>=22`? — ANSWERED, see above: `>=22.12.0`.** Advertising `>=18` was a
compatibility claim no CI job verifies — the suite, the builds and every
deployed runtime are 22. Either the claim should be narrowed to what is tested,
or a CI job should actually exercise the lowest supported Node. Narrowing is a
**breaking change for adopters on Node 18/20**, which is why it is a decision
and not a cleanup. Note Node 18 is EOL (2025-04-30) and Node 20 since
2026-04-30, so `>=18` currently advertises support for two dead runtimes.

**2. When to move everything 22 → 24?** Node 22 is in maintenance until
**2027-04-30**; Node 24 is Active LTS until 2026-10-20, then maintenance to
**2028-04-30**. There is no urgency, and 22 was chosen for this epic precisely
so the worker matches `.nvmrc`/CI rather than leading them. The bump should move
`.nvmrc`, root `engines`, CI, the worker, the Lambda runtimes, the esbuild targets
and both scaffold templates **together** — a partial bump is what produced the split this file
exists to record.

## Fix direction

(1) is decided. Do (2) as
one coordinated change with a single commit touching every row of the table
above, and re-check that table afterwards.

## Also worth a glance

~~`docs/deploying-to-aws.md` says "Node.js 22+" in its prerequisites.~~ Done in
PR #308: now reads "Node.js 22.12+ (the published packages' `engines` floor)",
since (1) made it an enforced floor rather than a recommendation.
