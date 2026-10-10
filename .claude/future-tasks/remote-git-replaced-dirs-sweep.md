---
priority: P3
adopters: BOTH
summary: >-
  A `remote.git.replaced-<ms>` directory, kept when a push lands in the old remote.git while the worker swaps in its replacement, is reported only by a log line and never cleaned up or surfaced in System health.
---
# Surface or sweep a kept `remote.git.replaced-*` directory

`CmsWorker.replacePoisonedRemoteGit()` (`packages/canopycms/src/worker/cms-worker.ts`) renames the
old `remote.git` aside, then lists its refs again. If a push landed in it during the swap (a Lambda
whose NFS cache still resolved the old name), the directory is kept rather than deleted, and the
worker logs one `workerLogError` line. Nothing records it in `worker-status.json`, and nothing
deletes it later, so in prod, with no EFS shell, the ref inside is never recovered and the
directory sits there for ever.

The window is narrow, and the commit normally survives in the Lambda's own clone, which pushes it
again. Options: record kept directories in the worker status report so System health shows them,
or have a later boot compare each one against the GitHub mirror and fetch any ref GitHub lacks
into `remote.git` before deleting it.
