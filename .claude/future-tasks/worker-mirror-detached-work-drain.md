---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from PR 2b's review of the GitHub mirror's upkeep (worker/github-mirror.ts). Four things are left open, each bounded today (the fifth, a killed push's transport child, was settled in PR 4b):
  - The gateway's detached work (every GitHub fetch job, and the maintenance run) is not tracked by the worker's drain. In dev, their gits sit in their own process groups, so Ctrl-C leaves them running, and the next start's sweep can delete their live locks and temporaries.
  - `create()` deletes and re-inits a mirror that `isBareRepository` failed on, without the maintenance mutex, and that check turns any error into "not a repository".
  - A rebuild waits for running maintenance while holding the session, so every operation stalls for up to the maintenance step deadlines.
  - A rebuild needs room for two mirrors, and on ENOSPC it retries the whole fetch every backoff.
---

# [P3] Stop the GitHub mirror's detached work at the drain, and narrow what re-creates it

Found while reviewing PR 2b of the worker process split (`worker-shared-repo-git-process-split.md`).

1. **Detached work outlives the drain.**
   - What runs detached: `GitHubMirror.afterFetch` starts maintenance with `void`, and every GitHub fetch job runs apart from its callers' signals, the boot pre-fetch from `GitHubGateway.prepare()` included.
   - Why it survives: neither is tracked by `CmsWorker.stop()`'s drain. Both run their gits through `runGit`, which spawns them `detached: true`, so the terminal's SIGINT does not reach them, and nothing awaits them.
   - Prod is covered: the unit's cgroup kill ends them. Dev is not: a worker restarted at once can sweep a running repack's `tmp_*`, which kills that repack and leaks its other temporaries.
   - **Fix:** give the gateway a `close()` that aborts both and awaits them, and call it from the drain. In split mode the gateway drains its requests on SIGTERM and exits, and its unit's `KillMode=mixed` cgroup kill takes a running fetch job (`canopycms-cdk/worker/gateway-run.ts`); dev keeps this gap.
2. **`create()` re-creates the mirror on any error.**
   - `isBareRepository` returns false for any error, a spawn failure (ENOMEM on a t4g.nano) included. `create()` then deletes the mirror and runs `initMirror` without the maintenance mutex, under a running repack. Nothing is lost but one whole-repository fetch.
   - **Fix:** distinguish "git says it is not a repository" (exit 128) from "git could not run", and take the mutex before deleting.
3. **A rebuild holds the session while it waits for maintenance.**
   - Each maintenance step is bounded at 30 minutes, so a rebuild found while a large repack runs stalls every gateway operation behind it. Rebuilds are rare: corruption only.
   - **Fix, if it ever matters:** release the session and answer transient, retrying the rebuild once the mutex is free.
4. **A rebuild needs room for two mirrors.**
   - What happens: `GitHubMirror.heal` fetches the replacement into `github.git.rebuild` beside the corrupt mirror, which it keeps until the swap so a failed rebuild leaves it.
   - The risk: a mirror past roughly a third of the root volume can hit ENOSPC mid-rebuild, then download the whole repository again after every `REBUILD_BACKOFF_MS`, staying transient throughout.
   - **Fix:** after a failure caused by ENOSPC, delete the corrupt mirror and fetch into its place. A crash at that point leaves no mirror, which `create()` handles.
5. **A killed push's transport child: settled in PR 4b.** The GitHub-bound commands (the fetch, the
   push, the default-branch `ls-remote`) now run through `runGit` in their own process group, so an
   abort or a kill stops `git-remote-https` and `pack-objects` with git
   (`worker/github-gateway-abort.test.ts` holds both open and asserts the group gone).
