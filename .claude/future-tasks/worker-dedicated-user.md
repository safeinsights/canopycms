---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10 (R2 of the worker process-split plan). The worker unit runs as `ec2-user`, a NOPASSWD sudoer in `wheel`, `adm` and `systemd-journal`. `NoNewPrivileges` blocks the sudo, and the split worker unit hides the journal, but a dedicated non-login user removes the whole class. EFS reports files as uid 1000, so git in the clones then needs `safe.directory` handling
---

# [P3] Run the worker as a dedicated non-login user

**Found:** 2026-10-10, planning
[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md) (its R2).

Today `canopy-worker.service` has `User=ec2-user`. AL2023's cloud-init default user config gives
that user NOPASSWD sudo and (as recalled, not yet checked on a live instance) the `adm`, `wheel`
and `systemd-journal` groups, which the unit inherits through initgroups. What
stands between code running as the worker and those privileges is the sandbox:
`NoNewPrivileges`, `ProtectHome=tmpfs`, `ProtectSystem=strict`, and, in the split worker unit,
`InaccessiblePaths` on the journal (`HIDDEN_PATHS`, canopycms-cdk `src/constructs/worker-units.ts`).
The single-process unit kept for older bundles does not hide it.

A dedicated system user (`useradd --system --shell /sbin/nologin canopy-worker`) removes the
class. The cost: the EFS access point stamps every file uid 1000, and git refuses a repository
owned by another uid ("dubious ownership"). So either the new user is created with uid 1000,
after moving `ec2-user` off it, or every worker git passes `-c safe.directory=*`, as the Lambda
image already does in system config. Three more places name `ec2-user` or uid 1000 and move with
it: `canopy-inspect` (`--uid=ec2-user`), `inspect-checks` (`id -u` must be 1000), and the
gateway socket's `SocketUser=`/`SocketGroup=ec2-user`. Needs a template change and a contract bump.
