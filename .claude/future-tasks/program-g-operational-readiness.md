# Program G — Operational readiness

**Part of:** [production-readiness-program.md](production-readiness-program.md)
**Size:** M · **Status:** not started · **Blocked by:** F

Everything needed for people other than the original authors to run these
deployments confidently.

## Runbooks

A `RUNBOOK.md` per deployment (docs-site CMS, production, and the reusable
adopter guide in `docs/`), each covering:

- deploy — including the two-pass `editorOrigin` dance and the fact that infra
  changes need `cdk deploy`, not just a Lambda image update
- roll back — re-point the CloudFront origin path at the previous `builds/{sha}`
  and invalidate
- read logs — Lambda, transform Lambda, and the EC2 worker's CloudWatch log group
  (the SSO role cannot `ssm:StartSession`/`SendCommand`, which is why log shipping
  is default-on)
- recover a stuck branch — the admin System health panel paths from the
  git-admin-observability epic: worker liveness, task retry/delete, branch-health
  repair, purge-to-trash, registry quarantine. Production has no shell and no EFS
  access, so these are the *only* recovery mechanisms
- rotate secrets — GitHub bot token, Clerk secret key, Clerk JWT key
- add an editor — Clerk user/org setup, permissions and groups, path ACLs

## Standing smoke test

Workstream D's deployed-stack verification suite becomes the standing smoke test:
runnable against any deployment URL, by anyone, after any deploy.

## Ownership boundaries

Define and write down who owns what:

- CanopyCMS the package (release cadence, the integration-branch workflow, the
  prerelease channel)
- the docs-site deployment (content flow, editors, cutovers)
- website v2 when it resumes
- the boundary with `iac` (account baselines) — see open decision #5

## Release-channel wind-down

Once the program's Canopy work has landed:

- drain the integration branch to `main` and cut a real release
- put both adopter sites back on normal npm ranges rather than pinned prereleases
- `npm deprecate` superseded `-int.N` prereleases
- decide whether the prerelease channel stays as standing infrastructure or was
  a program-duration measure

## Documentation sweep

Run the project's doc agents over everything the program changed:
`update-codebase-guide`, `docs-architecture`, `docs-developing`, `docs-readme`.
Resolve every `program-*.md` file into `resolved/` with an implementation summary,
and move their index rows to the Resolved section.

## Definition of done

Someone who has not worked on this program can deploy, verify, diagnose, and
recover both sites using only what is checked in.
