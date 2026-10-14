---
priority: P3
adopters: NEITHER
summary: >-
  New 2026-10-14. The "Standalone CMS Image" CI job's `docker build` pulls `node:22-slim` (and the Lambda adapter) anonymously from public.ecr.aws and fails with `429 Too Many Requests — Data limit exceeded` several times a day, turning green PRs red until the job is re-run. Cache or authenticate the base-image pull
---

# CI: the CMS image job fails on public ECR's anonymous pull limit

`Dockerfile.cms` builds from `public.ecr.aws/docker/library/node:22-slim` and
`public.ecr.aws/awsguru/aws-lambda-adapter`. CI pulls both anonymously on every run of the
"Standalone CMS Image" job. Public ECR rate-limits anonymous pulls by data volume. Between
2026-10-12 and 2026-10-14 the job failed with
`429 Too Many Requests - Server message: toomanyrequests: Data limit exceeded` on at least five
PRs (#536, #543, #547, #555, #556), each green on a re-run of just that job.

## Options

- **Log in to public ECR in CI.** Authenticated pulls get a much higher limit. That needs AWS
  credentials in this job, ideally via GitHub OIDC with a pull-only role.
- **Cache the base layers.** Use buildx with a GitHub Actions cache (`cache-from`/`cache-to:
  type=gha`), so most runs don't re-pull the base images.
- **Retry the pull with backoff** in the smoke script before `docker build`, as a stopgap.

Keep `Dockerfile.cms`'s base images unchanged: adopters build from the same file.
