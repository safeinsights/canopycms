---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10 (R6 of the worker process-split plan). Once the split ships, the race-to-credential gap stays open wherever the worker runs as one process: dev mode, `canopycms worker`, and any adopter entrypoint that constructs `CmsWorker` itself. Document it in the security model and the worker entrypoint docs, and decide whether `canopycms worker` in prod mode should warn
---

# [P3] State that a single-process worker keeps the race gap

**Found:** 2026-10-10, planning
[worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md) (its R6).

The split moves the credential into a gateway unit only in the CDK deployment (worker contract
2). Everywhere else the worker runs as one process: dev mode, `canopycms worker`, `apps/test-app`,
and any custom entrypoint (an adopter on another auth provider writes its own). That process
still holds the credential beside its git in the shared repositories.

Do in the split's docs PR, or straight after it:
- The Security Model in `docs/deploying-to-aws.md` says so in one sentence.
- The custom-entrypoint section of the worker docs says how to run the gateway beside it.
- Decide whether `canopycms worker` in prod mode logs a one-time warning.
