---
priority: P3
adopters: BOTH
summary: >-
  `docs/deploying-to-aws.md` ("Worker capacity") and the `workerCapacity` doc comment in
  `cms-service.ts` say a spot shortage leaves `/edit` answering 500 on a first deploy; the code
  maps the missing `remote.git` to a 503 "CMS worker not ready" with `Retry-After`. Verify and fix both
---

# A worker-less first deploy answers 503, not 500

**Priority:** P3 (an operator reading the docs looks for the wrong status; nothing misbehaves).

Two places state that with no worker (a spot shortage, `workerCapacity: { type: 'spot' }`), a
first deploy's `/edit` answers 500 because nothing has created `remote.git`:

- `docs/deploying-to-aws.md`, the "Worker capacity" section;
- `packages/canopycms-cdk/src/constructs/cms-service.ts`, the `workerCapacity` prop's doc comment.

The code disagrees. The edit page is a client component (`edit-page.tsx.template` starts with
`'use client'`). The editor's API calls hit `git-manager.ts`, which throws `RemoteNotReadyError`
when `remote.git` is missing, and `http/worker-not-ready.ts` maps that to a 503 with the
`WORKER_NOT_READY_MESSAGE` body and `Retry-After`.

`docs/adopter-migration.md` already says 503. To do: confirm on a worker-less dev or deployed
stack (or with a handler test) what `/edit` and `/api/canopycms/*` answer, then correct both
statements to match.
