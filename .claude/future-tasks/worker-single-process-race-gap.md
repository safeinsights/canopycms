---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10 (R6 of the worker process-split plan). Since the split shipped (worker contract 2), the race-to-credential gap stays open wherever a `CmsWorker` runs with its own credential: an adopter entrypoint that constructs one (an adopter on another auth provider writes its own), and a bundle older than the split on the single-process unit. The Security Model says so. Left: document running the gateway beside a custom entrypoint, and decide whether `CmsWorker` given a credential in prod mode should warn
---

# [P3] State that a single-process worker keeps the race gap

**Found:** 2026-10-10, planning
[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md) (its R6).

The split moves the credential into a gateway unit only in the CDK deployment (worker contract
2), whose entrypoint refuses to run without the gateway's socket (canopycms-cdk `worker/run.ts`).
A `CmsWorker` constructed with a credential elsewhere runs as one process and holds it beside its
git in the shared repositories: an adopter's own entrypoint. (`apps/test-app`'s e2e route builds
one with a fake token, against `.canopy-dev`, only in dev or under `CANOPY_E2E=1`.)
`canopycms worker run-once` is not one: it builds no `CmsWorker`, runs no git in the clones and
holds no GitHub credential (`workerRunOnce`, `cli/init.ts`).

Done in the split's docs PR: `docs/deploying-to-aws.md`'s "What the separation leaves open" says
so. Left:
- Say how to run the gateway beside a custom entrypoint (`serveGitHubGateway` and
  `connectGitHubGateway` from `canopycms/worker/cms-worker`, as canopycms-cdk's `worker/index.ts`
  does). No doc covers that today.
- Decide whether a `CmsWorker` given a credential (not `githubGateway`) in prod mode logs a
  one-time warning.
