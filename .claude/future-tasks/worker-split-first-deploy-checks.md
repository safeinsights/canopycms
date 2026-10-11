---
priority: P1
adopters: BOTH
summary: >-
  New 2026-10-11, from the worker process split. What the split rests on but no container could prove has never been checked on a real AL2023 instance: only `lo` in the worker unit's network namespace (fallback tunnel devices), the core-dump sysctls after boot, the gateway log reaching CloudWatch, EFS read/write from a `PrivateNetwork` unit through efs-utils, the App preflight, IMDS unreachable from the worker, and which other filesystem unix sockets uid 1000 can connect to (R7). Run docs/deploying-to-aws.md's "First deploy checklist" on the first deploy of a contract-2 bundle and record the results here
---

# [P1] Check the worker process split on its first real deploy

**Found:** 2026-10-11, closing
[worker-shared-repo-git-process-split.md](resolved/worker-shared-repo-git-process-split.md) (§8
"Carried from 6", §9 R7, §10's "Needs a real deploy" rows).

The split was verified in an AL2023 container under systemd 252 (the plan's §10), which cannot
show host-global sysctls, NFS from a `PrivateNetwork` unit, or EC2's metadata service. The worker
and the gateway fail closed on the most important of these (each refuses to start), so a
failure shows as a worker that never syncs rather than as a silent hole. But nobody has seen
them pass.

## Checks

`docs/deploying-to-aws.md`, "First deploy checklist", is the operator's version. Record for each:
pass, or what was seen.

1. `canopy-worker` runs; `canopy-inspect cat /proc/self/net/dev` lists `lo` alone;
   `sysctl net.core.fb_tunnels_only_for_init_net` prints 1. If tunnel devices appear, either keep
   the sysctl or let the `network-namespace` self-check accept them (§8 "Carried from 4b").
2. `sysctl kernel.core_pattern fs.suid_dumpable` prints `core` and 0 after boot (host-global; the
   gateway's own check proves only that `core_pattern` is not piped).
3. The worker log group has an `{instance_id}-gateway` stream (`gateway.log` is 0640 root, so the
   agent must run as root).
4. A git sync completes (EFS read and write from the worker unit), the gateway log shows no App
   preflight failure, and `canopy-inspect curl -m 5 http://169.254.169.254/` fails.
5. **R7:** list the filesystem unix sockets on the instance (`ss -xlp`, `find / -type s`) and
   which of them uid 1000 can connect to from the worker's sandbox. Anything beyond the gateway's
   socket is a lever the split did not plan for.
