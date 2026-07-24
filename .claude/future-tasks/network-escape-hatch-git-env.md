# Network escape-hatch git ops run with the restricted env allowlist

Flagged by PR #141 review (LOW).

## Problem

Under the `allowNetworkRemoteInProd` escape hatch (single-VM prod topology with a
network `origin` instead of the intended local `remote.git`), `GitManager`'s
`this.git.fetch(this.remote, ...)` / `this.git.raw(['push', ...])` calls run against a
real network remote — but `this.git`'s child env is still the restricted allowlist from
`gitChildEnv` (see `git-manager.ts`), which intentionally drops `HTTPS_PROXY`,
`GIT_SSL_*`, and `GIT_SSH_COMMAND` to protect the normal (local-remote) prod topology.

Under the escape hatch specifically, this means network git ops through `this.remote`
would fail behind a proxy or with custom TLS/SSH config, even though the worker's
separate full-env `simpleGit()` instances (used for its own push/fetch) succeed in the
same environment.

The `GitManager` constructor comment now documents this limitation explicitly (see the
comment above `this.git = simpleGit(...)` in `git-manager.ts`).

## Fix direction

When `allowNetworkRemoteInProd` is on, consider giving `this.git`'s remote-facing calls
(fetch/push against `this.remote`) the same full-env treatment the worker's push/fetch
paths already use, instead of the restricted allowlist — while keeping the allowlist for
purely local working-tree ops. Needs a design pass: `this.git` is a single `SimpleGit`
instance shared by both local and (under the escape hatch) remote calls, so this likely
means either swapping envs around remote calls or introducing a second git instance for
the escape-hatch path.
