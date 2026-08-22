# [P3] Node versions are stated in six places and do not all agree

Owed from the 2026-08 infra-review epic's plan (I said I would file the
repo-wide 22 → 24 bump and did not), plus two inconsistencies the round-4
independent review surfaced. Filed together because they are one decision, not
three.

## Where Node versions are declared today, after the epic

| Place | Value | Set by |
| --- | --- | --- |
| `.nvmrc` | `v22` | pre-existing |
| root `package.json` `engines` (private) | `>=22` | pre-existing |
| **published packages' `engines`** (all five) | **`>=18`** | pre-existing |
| EC2 worker (`cms-service.ts` user-data) | `nodejs22` / `/usr/bin/node-22` | this epic |
| transform Lambda | `NODEJS_22_X` | pre-existing |
| scaffold `Dockerfile.cms.template` + `deploy-cms.yml.template` | `22` | this epic |
| `examples/aws-deployment/deploy-cms.yml` | `22` | round-4 cleanup |

So the runtimes are now consistent at 22. **The published `engines` are not**:
all five packages advertise `>=18`, a floor nothing builds or tests against.

## The two questions

**1. Should published `engines` say `>=22`?** Advertising `>=18` is a
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
`.nvmrc`, root `engines`, CI, the worker, the Lambda runtimes and both scaffold
templates **together** — a partial bump is what produced the split this file
exists to record.

## Fix direction

Decide (1) first: it is adopter-facing and independent of (2). Then do (2) as
one coordinated change with a single commit touching every row of the table
above, and re-check that table afterwards.

## Also worth a glance

`docs/deploying-to-aws.md` says "Node.js 22+" in its prerequisites (updated by
this epic). If (1) lands as `>=22`, that becomes the enforced floor rather than
a recommendation, and the wording should follow.
