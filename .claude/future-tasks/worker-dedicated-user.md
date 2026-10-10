---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10 (R2 of the worker process-split plan). The worker unit runs as `ec2-user`, a NOPASSWD sudoer in `wheel`, `adm` and `systemd-journal`. `NoNewPrivileges` blocks the sudo, and the plan hides the journal, but a dedicated non-login user removes the whole class. EFS reports files as uid 1000, so git in the clones then needs `safe.directory` handling
---

# [P3] Run the worker as a dedicated non-login user

**Found:** 2026-10-10, planning
[worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md) (its R2).

Today `canopy-worker.service` has `User=ec2-user`. On AL2023 that user has NOPASSWD sudo and the
`adm`, `wheel` and `systemd-journal` groups, which the unit inherits through initgroups. What
stands between code running as the worker and those privileges is the sandbox:
`NoNewPrivileges`, `ProtectHome=tmpfs`, `ProtectSystem=strict`, and (in the split)
`InaccessiblePaths` on the journal.

A dedicated system user (`useradd --system --shell /sbin/nologin canopy-worker`) removes the
class. The cost: the EFS access point stamps every file uid 1000, and git refuses a repository
owned by another uid ("dubious ownership"). So either the new user is created with uid 1000,
after moving `ec2-user` off it, or every worker git passes `-c safe.directory=*`, as the Lambda
image already does in system config. Needs a template change and a contract bump, so it lands
after the split.
