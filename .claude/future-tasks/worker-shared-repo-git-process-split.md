---
priority: P1
adopters: BOTH
summary: >-
  IN PROGRESS. A compromised CMS Lambda that races the worker can still run a command as it, and from there obtain the GitHub credential (planted filter or merge drivers, edited rebase state). Fix, decided 2026-10-10: a credential-free, network-less worker unit plus a no-EFS GitHub gateway unit holding every secret, behind a typed socket API. Reviewed in 11 adversarial rounds; shipping as PRs 1–7 into int-202610-b
---

# [P1] Run the worker's shared-repository git without the credential

**Priority:** P1 [BOTH]. **Found:** 2026-10-09, while resolving
[worker-git-config-from-shared-efs.md](resolved/worker-git-config-from-shared-efs.md).
**Status:** design decided 2026-10-10 (§11). Two prerequisites already shipped: #490 (the worker
never pushes the base or default branch) and #491 (root-owned worker log). PRs 1–7 (§8) go into
`int-202610-b` one at a time.

## What stays exploitable until this lands

The worker and the CMS Lambda both write `remote.git` and every branch clone on EFS. The worker's
own git there runs pinned, after a config allowlist check (`worker/shared-repo-git.ts`), and the
credential is used only in a private mirror (`worker/github-mirror.ts`). What is left needs a
race the check cannot win, because it reads before git does:

- a `filter.<driver>.*` or `merge.<driver>.driver` key written between the check and git's read,
  selected by attributes, runs in any working-tree operation in a clone;
- while the worker's rebase is stopped at a conflict, an `exec` line in `git-rebase-todo`, or a
  `strategy` file, runs on its `rebase --continue`;
- a submodule populated after the check runs git inside it on `rm --sparse`.

Each runs as the worker user, which can reach IMDS, so it holds the instance role, which reads
the GitHub credential (and the Clerk key) from Secrets Manager. A single-process worker (dev, a
custom entrypoint) keeps this gap after the split: see R6.

The design below was written as a plan and reviewed before any code; §12 keeps every review
finding and its response, and §10 how each claim was verified. Line numbers cite
`int-202610-b` as of 2026-10-10 and may drift.

## 0. Summary

Neither option in the task file. **Put the narrow interface in front of the credential, not in
front of git.** A small credentialed service, the **GitHub gateway** (`canopy-github.service`,
its own system user), holds every secret, the private mirror, Octokit and the network. It
**cannot see EFS**. Everything else the worker does today stays in `canopy-worker.service`:
the task queue, the git-sync cluster, locks, `worker-status.json`, every git command in
`remote.git` and the clones. That unit loses the network (`PrivateNetwork=yes`,
`IPAddressDeny=any`) and every secret. The two talk only over one local unix socket, HTTP/1.1,
through a fixed set of typed operations. Objects cross as git bundles streamed over the socket,
so the gateway never runs git in, or opens a path in, anything the Lambda or the worker can
write. In the gateway, the credential reaches git through the environment, never argv.

A compromised Lambda that wins the race now runs code in a process with no network, no
credential and no IMDS route. Beyond EFS, the only thing it can reach is the gateway's typed
API, which it can already drive through the task queue. What that API lets anyone do on GitHub
is the same as today, minus pushes to protected branches (§9 R1). A `.github`/workflow-file
refusal was tried in v2–v7 and is now deferred to its own decision (§11 D10).

## 1. Threat model

- **Attacker:** a compromised CMS Lambda. It writes everything on EFS as uid 1000 through the
  access point: `remote.git`, every clone (config, attributes, rebase state), `.tasks/`,
  `branch.json` and the auth cache. It retries every sync cycle, so it wins any race eventually.
  Assume it also runs arbitrary code as the worker unit.
- **Assets:**
  - the GitHub credential: the PAT, or the App key and every installation token minted from it;
  - the Clerk secret key;
  - the instance role, which reads both from Secrets Manager and is reachable by any local
    process with an IP route to IMDS. IMDS is IPv4-only here: the launch template sets no
    `httpProtocolIpv6`.
- **Goal:**
  - Winning the race yields none of these assets.
  - It yields no GitHub operation that the gateway's API does not name.
- **Not this change's goal:** narrowing that API further than today's task queue already does.
  It shrinks a little (§3.2 policy); the rest is a decision (§11 D9).

## 2. The trust boundary: three options, weighed

Evidence (int @ 66d12eea). Every credential touch today, by file:

| Site | What it does with the credential | Shared-repo git nearby |
| ---- | -------------------------------- | ---------------------- |
| `cms-worker.ts` `ensureGitHubAuth`, `octokitClient`, `buildGitHubUrl` (L1308) | Resolves the token and builds Octokit. **The token goes in the URL, so into git's argv.** | — |
| `cms-worker.ts` `ensureRemoteGit` | Mirror fetch from GitHub; `seedBareRepository` into a staging dir on EFS. | `init`, `assertSharedRepoConfig`, `verifyBaseBranchExists`, HEAD, config, scrub |
| `cms-worker.ts` `resolveBaseBranch` | `repos.get` default branch, when `remote.git` is absent. | `readHeadBranch` |
| `git-sync.ts` `syncGit` (L501) | Mirror fetch, then `publishTrackingRefs`, which pushes into `remote.git` **with receive-pack running in `remote.git` as the credentialed user**. | Reconcile, settings, base refresh, rebase cycle |
| `git-sync.ts` `pushSettingsBranches` (L208) | `mirror.pushToGitHub`. | `git.branch()`, `revparse` in `remote.git` |
| `task-runner.ts` `pushBranchToGitHub` (L680) | Mirror `fetchFromRemoteGit` (**upload-pack in `remote.git`, as the credentialed user**); push with lease; stale-lease retry. | `assertSharedRepoConfig`, `readPublishedSha`, the `branch.json` marker |
| `task-runner.ts` `executeTask`, `github-service.ts` `createOrUpdatePullRequest` (L161) | `pulls.*`, `git.deleteRef`, GraphQL mark-ready. | `branch.json` reads |
| `task-runner.ts` L291, `cms-worker.ts` L1449 | `refreshGitHubCredential` after a failure. | — |
| `rebase.ts` `pollMergeState` (L139) | `pulls.get`. | Inside the rebase loop |
| `canopycms-cdk/worker/run.ts`, `secrets.ts`, `github-app-auth.ts`, `credential-refresh.ts`, `clerk-refresh.ts` | Secrets Manager, App auth, Clerk API. The Clerk refresher **writes the auth cache to EFS**. | — |
| `canopycms-cdk/worker/termination-watch.ts` | IMDS spot/ASG notice; `CompleteLifecycleAction`. | — |

Observations that decide it:

1. **The rebase loop already talks to the push side through the task queue.** `history-rewrite.ts`
   L192 runs mark → publish → `enqueueTask push-branch`. Its only direct GitHub call is
   `pollMergeState`.
2. **Every git command the credentialed side runs against EFS is in `github-mirror.ts`:** the
   local fetch from, and push into, `remote.git`, whose pack commands run **in `remote.git` as the
   credentialed user**.
3. **The credentialed process also does file I/O on EFS:** `branch.json`, the queue's renames,
   status files, the auth cache. It does so with the file access of the user that owns the
   mirror. A planted symlink that ever led a write into the mirror's config, say a
   `url.<x>.insteadOf`, would send the token anywhere. No exploit is known, but nothing
   structural rules one out.

**Option A, the task file's lean.** The git-sync cluster moves into an unprivileged process;
the credentialed process keeps the queue on EFS.
- **Moves:** `git-sync.ts`, `rebase.ts`, `sparse-cone.ts`, `canopy-state.ts`, `schema-gate.ts`,
  `provisioned-workspace.ts`, `remote-git-maintenance.ts`, most of `history-rewrite.ts`.
- **Stays credentialed:** `task-runner.ts`, the mirror, github-auth, the queue.
- **Open questions it leaves:** `pushBranchToGitHub` still needs `readPublishedSha` and objects
  from `remote.git`. Either observation 2 stays open, or every push becomes a two-stage queue
  round trip.
- **Observation 3 stays whole.**

**Option B, a narrow git helper.** The credentialed process keeps all the logic and runs each
shared-repository git command through a sandboxed "run this argv" helper. `sharedRepoGit` is
already the choke point, so this is the smallest diff.
- All the clone-tree file I/O (`rebase.ts`, `canopy-state.ts`, `sparse-cone.ts`, residue repair)
  stays credentialed, so observation 3 stays whole.
- Observation 2 needs fixing separately.
- The helper is a bespoke remote-exec with stdio and abort relay: a wide interface.

**Option C, recommended: a narrow GitHub gateway.** Invert B.
- **Credentialed side:** `github-mirror.ts`, `github-auth.ts`, the CDK entry's secret, App,
  Clerk, credential-refresh and termination modules, and new `github-gateway*.ts`. It has no EFS
  (`InaccessiblePaths=`), so observations 2 and 3 cannot arise.
- **Unprivileged side:** everything else. The only change to its logic is that
  `ctx.octokit()`, `ctx.buildGitHubUrl()`, `ctx.githubMirror()` and
  `ctx.refreshGitHubCredential()` become one `ctx.github()` returning a `GitHubGateway`.
- **Untouched:** the task queue and all its semantics (retries, `failed/`, `PermanentTaskError`,
  orphan recovery).

## 3. Design

### 3.1 Processes

| Unit | User | Network | Sees EFS | Holds |
| ---- | ---- | ------- | -------- | ----- |
| `canopy-worker.service` | `ec2-user` (uid 1000), unchanged | **None:** `PrivateNetwork=yes`, `IPAddressDeny=any` | Yes (rw) | Nothing secret. The queue, git-sync, locks, status, and the auth-cache write. |
| `canopy-github.socket` | Socket node owned by `ec2-user`, mode `0600` | — | — | `/run/canopy-github/gateway.sock` |
| `canopy-github.service` | `canopy-github`, a static system user | Full: GitHub, Secrets Manager, Clerk, IMDS, ASG | **No** | Secrets, the mirror (`/var/lib/canopy-github`), Octokit, the termination watch |

The gateway:
- is socket-activated (`Accept=no`), takes the listening fd from systemd, and calls
  `server.listen({ fd: 3 })`;
- is also enabled at boot, so its secret reads and App preflight run before the worker's first
  call;
- listens on that socket. Only `ec2-user` (the socket node's owner) and root can connect.
- starts its own first GitHub fetch at boot, so the worker's first `fetch` after a lock
  handover joins a warm or finished job. Otherwise the new instance's full fetch lands inside
  the no-worker window of a roll.

Stop ordering:
- **Worker unit:** `After=canopy-github.service canopy-github.socket` and
  `Requires=canopy-github.socket`. systemd stops it first, so its 90 s drain runs while the
  gateway is still up.
- **Gateway unit:** `KillMode=mixed` and `TimeoutStopSec=150`. On SIGTERM it refuses new
  requests, finishes in-flight push and Octokit requests, and **kills** a running fetch job
  (the worker draining has no use for it). Whatever is left is SIGKILLed with the cgroup.
- **While the worker drains,** "gateway unreachable" maps to `TaskAbortedForShutdownError`. No
  retry is spent, as for today's drain abort (`task-runner.ts` L244).
- **Gateway unit** also has `Requires=canopy-github.socket` and `Sockets=canopy-github.socket`,
  so a direct `systemctl start` still gets fd 3.
- **Fetch is a job, not a request.**
  - `fetch` starts the gateway's GitHub fetch, or joins one already running, and answers `202`
    with a job id. Ids are **per request**: each maps to the shared GitHub fetch, and each gets
    its own bundle for its own `have`. The worker polls `fetch/:id` until it reports the ref map
    and `bundleId`.
  - The job is detached from client aborts. The gateway kills it itself on inactivity: no
    progress output for `taskTimeoutMs` (simple-git's `timeout.block`, as today), plus
    `http.lowSpeedLimit`/`lowSpeedTime`. A killed job fails. That is a failed GitHub-bound operation, so
    it arms the refresh (§3.2). Inactivity is measured from the job's git spawn, not its creation. A **failed** job
    is never joined; a **completed** one is reused for the 30 s coalescing window.
  - **At gateway start**, before any git runs (systemd 252 SIGKILLs the whole cgroup when the
    main process exits under `KillMode=mixed`, `service.c` L1998–2000, `unit.c` L4615, so nothing
    survives a restart), it sweeps what a SIGKILL left: everything under
    `incoming/`, outgoing bundles, `objects/pack/tmp_*`, `objects/pack/pack-*.keep`, and every
    `*.lock` in the mirror (`refs/**`, `packed-refs.lock`, `config.lock`, `shallow.lock`,
    `objects/info/commit-graphs/*.lock`, `objects/info/commit-graphs/tmp_*`, and repack's
    `objects/pack/.tmp-*-pack-*`). Round 6 verified that a leftover `refs/heads/main.lock`
    fails every fetch with "cannot lock ref". After start, a lock is stale only if neither a session nor
    maintenance holds the mirror. So the **on-failure sweep** runs only when a fetch fails with
    `Unable to create '…\.lock': File exists`. It runs as a plain call inside the fetch job's
    own session (never a nested `exclusive`), and it **try-acquires** the maintenance mutex
    (below):
    - **held by maintenance:** the lock is live by definition, so the sweep skips, and the fetch
      fails `transient`;
    - **free:** it removes only `*.lock`, `objects/pack/tmp_*`, `.tmp-*-pack-*`, `pack-*.keep`
      and commit-graph temporaries. It never touches `incoming/` or outgoing bundles, which may
      be live: an upload streams outside `exclusive`, and the sync loop downloads outside it.
      Then it releases the mutex, and the job retries its fetch once.

    It never waits on the mutex while holding `exclusive`, so it cannot stall pushes behind a
    repack. A fetch job killed for inactivity removes its own `tmp_pack_*` and `.keep` in the
    same session, since a `.keep` would otherwise pin a pack through every repack until restart. A worker that polls an unknown job id (the gateway
    restarted, or retention passed) issues one new `fetch`. Today's
    mirror fetch is bounded only by inactivity (`--progress`, `github-mirror.ts` L170). A
    whole-repository first fetch on a fresh instance can outlast any wall-clock client timeout,
    and killing it on the client's abort would livelock startup.
  - The worker's bound is inactivity: the job's progress counter must move within
    `taskTimeoutMs`. `health` waits up to 300 s, for the secret reads (`getSecret` can take
    87 s; `cms-worker.ts` L1481).

**Nothing a root process opens by name may be the worker's (round 2's CRITICAL).** systemd 252
opens `StandardOutput=append:` targets in `exec_child` before it applies the mount namespace or
drops to the unit's user. It does so as root, with a plain `open(… O_CREAT|O_APPEND)` that
follows symlinks (`src/core/execute.c` L386–395, L4393 vs L4724 and L4924). Today
`LogsDirectory=canopy-worker` and user-data's `chown` give `ec2-user` the log directory. So
after the split, a worker that won the race could:
1. replace `worker.log` with a symlink to `/etc/ld.so.preload`;
2. exit;
3. let `Restart=always` bring it back, at which point systemd appends the worker's output to
   that file, as root;
4. print the path of a shared object it left in its own log directory.

Every root process started after that loads the object: root, then the gateway's credential.
Today this changes nothing, because the worker already holds the credential. After the split it
is the whole game.

Rules:
- **Log directories are root-owned.** `/var/log/canopy-worker` and `/var/log/canopy-github` are
  `root:root 0755`. `worker.log` and `gateway.log` are pre-created `root:root 0640`. Neither unit
  has `LogsDirectory=` (it chowns to the unit's user). Each process writes only through the fd
  systemd hands it, which needs no write permission on the path. logrotate's `copytruncate`
  (root) then also runs in a root-owned directory.
- **`CacheDirectory=`/`StateDirectory=`** are safe: systemd's recursive chown opens every entry
  with `O_NOFOLLOW` (`src/shared/chown-recursive.c` L74, L119), and `/var/cache` and `/var/lib`
  are root-owned.
- **The audit list** in PR 6: every path a root process (systemd, user-data, logrotate, the
  CloudWatch agent, efs-utils' watchdog) opens by name, each shown not to be in a directory the
  worker can write. The container check plants the symlink and restarts the worker.

### 3.2 Gateway API

Transport is HTTP/1.1 over the socket: `node:http` with zod validation. Every op is its own
request. Bundles are request or response bodies, and their metadata travels in a separate JSON
request, so no framing is invented.

| Op | Input (validated) | Output |
| -- | ----------------- | ------ |
| `health` | — | Ready, or the gateway's fatal error. Also: the protected-branch set, `clerkConfigured`, and the App preflight result. |
| `fetch` | `have`: object IDs, the worker's `refs/heads/*` plus its tracking tips. Capped at 10 000. | `202` with a job id (§3.1). |
| `fetch/:id` (GET) | — | The job's progress; when done, GitHub's full ref map plus a `bundleId` (null when there is nothing new). |
| `bundle/:id` (GET) | — | The bundle stream, deleted after download or after 10 min. |
| `push` | `branch`, `sha`, optional `lease`, `prerequisites` (≤ 3 object IDs the worker would exclude). Body optional: a bundle with one head at `sha`. | `pushed`, `up-to-date` or `pushed-past-stale-lease`, with the SHA. Or `need-objects { usable }`: the subset of `prerequisites` that are commits reachable from a mirror `refs/heads/*` tip. Or an error (below). |
| `pr.createOrUpdate` | What `createOrUpdatePullRequest` takes today, including `markReadyIfDraft` and `mergeSectionIntoBody`. Lengths capped. | What it returns today. |
| `pr.create`, `pr.update`, `pr.get`, `pr.convertToDraft`, `pr.close` (`pr.create` serves the legacy `push-and-create-pr` action, `task-runner.ts` L364) | The fields `task-runner.ts` passes today. | The fields `task-runner.ts` and `pollMergeState` read. |
| `deleteBranch` | `branch` | `deleted` or `alreadyGone` |
| `defaultBranch` | — | GitHub's default branch |
| `authSnapshot` | — | Clerk users, orgs and memberships, as data |
| `termination` | Bounded poll (≤ 60 s) | Spot/ASG notice, or none |
| `completeLifecycle` | — | Done. Logged in the gateway's log. |

**Errors keep today's classification.**
- **Octokit failures** come back as `{ status, message, headers: { x-ratelimit-remaining,
  retry-after }, data }`, verbatim after redaction. `data` is the response body:
  `isNoCommitsBetweenError` prefers `response.data.errors[]` (`github-service.ts` L275). The
  worker rebuilds an error with the same `.status`, `.response.headers`, `.response.data` and
  message, so its existing classifiers keep working:
  - `isPermanentTaskFailure` and `isRateLimitSignal403` (`task-runner.ts` L119–161);
  - `isNoCommitsBetweenError` (L437, which unlocks the branch through `NothingToSubmitTaskError`);
  - `isRefAlreadyGoneError` (L528).
- **Git push failures** come back as one of four codes:
  - `non-fast-forward`;
  - `stale-lease`, when the plain retry is rejected too;
  - `workflow-refused`, carrying the file name for `throwIfWorkflowRefusal` (L667);
  - `transient`.
- **The gateway's own refusals:**
  - `refused-by-policy` becomes `PermanentTaskError`;
  - `bundle-rejected` (a malformed header, a failed fsck, oversize) is `transient`, bounded by
    the task's retry budget (`DEFAULT_MAX_RETRIES = 3`), as is a prerequisite that is not
    reachable (§3.3 intake step 2).

**The push-identity invariant.** Three clauses, stated because node's and git's bundle-header
parsers disagree (git reads everything after the first space as the refname, and accepts a
tab):
1. **What is pushed** to GitHub is always the request's validated `sha`, never a value read from
   a bundle header.
2. **The branch** in every refspec comes from the validated JSON `branch`, never from the bundle.
3. **`cat-file -t <sha>` must be `commit`** in the mirror before any push. A bundle can carry a
   blob head; round 2 verified one fetches into a staging ref.

A test: a bundle that advertises extra, renamed or space-embedded refs either pushes exactly
`sha` or is refused.

**The push op, in full.** The gateway:
1. validates `sha`, `lease` and `prerequisites` as full object IDs;
2. **joins a coalesced GitHub fetch** before anything else, so the mirror's `refs/heads/*` are
   GitHub's heads. If the fetch fails, or the mirror still has no heads, the answer is
   `transient`, before any reachability test, `need-objects` or policy. That rules out:
   - a false `refused-by-policy` against stale heads during an outage;
   - a `need-objects` loop against an unfetched mirror;
3. **with no body:** a three-way branch on `cat-file --batch-check`'s output for `<sha>`,
   which round 10 verified prints `<oid> missing` deterministically, unlike `cat-file -t`'s
   shared exit 128:
   - **`missing`** → `need-objects` (below);
   - **a type other than `commit`** → `refused-by-policy`, as in step 5;
   - **`commit`** → `for-each-ref --contains <sha> refs/heads/`. Round 9 verified that it exits
     129 on a missing or non-commit object, which this ordering avoids. Any other non-zero exit
     is `transient`;

   Then:
   - if `sha` is **reachable from a mirror `refs/heads/*` tip** (`for-each-ref --contains <sha>
     refs/heads/` is non-empty), it continues. Merely present is not enough: round 3 verified
     that an ingest which fails fsck still leaves its pack, so `sha` exists, reads as a commit,
     and cannot be pushed ("unpacker error"). A presence test would never ask for objects
     again, and the branch would wedge;
   - otherwise it answers `need-objects { usable }`. The worker builds a bundle with exactly
     those prerequisites (none if `usable` is empty) and calls again with the body. That is one
     extra round trip at most, with no retry ladder, and the bundle is never sent twice;

   **Steps 3–7 run inside one `exclusive` session,** acquired once, after step 2's join. The
   fetch job holds `exclusive` itself, so joining it while holding the session would deadlock.
   `exclusive` is not re-entrant: step 7 is today's block body run as plain calls, never a
   nested `exclusive`.
4. **with a body:** it ingests it into a **quarantine** repository (§3.3), never the mirror. A
   prerequisite that was in `usable` but is no longer reachable after step 2's fetch (the branch
   was deleted or force-pushed on GitHub meanwhile) makes the ingest `transient`, not
   `bundle-rejected`, so the next attempt recomputes `usable`;
5. requires `sha` to be a commit (clause 3). A non-commit (say, a Lambda-planted blob at
   `refs/heads/<x>` in `remote.git`) is `refused-by-policy` → `PermanentTaskError`, because a
   retry cannot change it;
6. applies policy (below), in the quarantine or the mirror, whichever holds `sha`;
7. runs the body of today's `mirror.exclusive` block from `pushBranchToGitHub`, from that same
   repository: lease push, the stale-lease plain retry, and "Everything up-to-date" absorbed as
   success.

The worker:
- always sends the JSON-only push first. That covers, with no bundle at all:
  - an up-to-date settings branch, every cycle;
  - a task re-run after a crash;
  - a branch equal to base;
  - a branch that is an ancestor of GitHub's tip, where `bundle create` would refuse an empty
    bundle. The plain push then fails non-fast-forward, with today's text and classification
    (`task-runner.ts` L767).
- if `bundle create` still says "Refusing to create empty bundle", sends no body; the gateway
  then answers from the mirror. A second `need-objects` for the same push fails `transient`
  rather than looping;
- uses the **returned** SHA for [SYNC-H1]'s `outgoingSha !== marker` test (L791). The returned
  SHA is always `sha`, so that test is unchanged;
- keeps the marker read and clear, `recordPushedToGitHub`, and all of `history-rewrite.ts`.

**Credential refresh is the gateway's.**
- **What arms it:** any failure of an operation that reached, or tried to reach, GitHub or
  Clerk:
  - a GitHub-bound git command's non-zero exit, including an inactivity kill, **except** a
    failure with the lock text (`Unable to create '…\.lock': File exists`) on a line of the
    gateway git's own output, never a `remote:`-prefixed line from GitHub, which is
    gateway-local: it means `pack-refs` holds the lock, not a credential problem;
  - any Octokit error;
  - any Clerk error.

  This is today's ungated rule (`cms-worker.ts` L1471–1479 says why: a dead token's git failure
  is a plain exit 128, and round 8 verified that a bad token, a missing repository and no auth
  all print the same "could not read Username" line). It also keeps recovering a token that is
  valid but has lost access (404, or a SAML or IP-allowlist 403), once an operator rotates in a
  working one.
- **What never arms it:** the gateway's own local refusals (`need-objects`, `bundle-rejected`,
  `refused-by-policy`, a vanished prerequisite, header and size refusals). The bound on what a
  hostile worker can drive is the floors:
  - **token path:** at most one provider call per 60 s (core, `github-auth.ts` L156, L304–317),
    and behind it at most one `GetSecretValue` per secret per 5 minutes
    (`credential-refresh.ts`);
  - **App path:** `refreshCredential` is a no-op (`github-auth.ts` L266–272). Installation
    tokens are minted only by `@octokit/auth-app`'s own 59-minute cache, which no request can
    drive. Any App re-mint PR 1 adds must bring its own floor and a test.
- **Clerk: exactly today's gate.** Only a Clerk 401/403 (`clerk-refresh.ts` L103,
  `isClerkAuthRejection`) arms the key re-read and the single retried snapshot. Arming on any
  Clerk error would let a hostile worker stamp the 5-minute floor during a Clerk 5xx and delay
  a real rotation's recovery.
- It **starts** the refresh detached, after responding, behind today's floors (60 s in
  `github-auth.ts`, 5 min in `credential-refresh.ts`). The refresh never delays the failure
  response: the worker's task deadline is 60 s, and `getSecret` can take 87 s.
- Every credentialed operation **joins** an in-flight refresh before using the credential,
  bounded by its own deadline. So the 5 s/10 s/20 s retries (`credential-refresh.ts` L36) see
  the new token, as they do today when `task-runner.ts` L291 awaits the refresh.
- `refreshGitHubCredential` leaves `WorkerContext`, and the two worker-side triggers are deleted.

**Gateway policy.** Enforced independently of what the worker asks, and in single-process
mode too.

- **Protected branches.** It never pushes to, leases or deletes a branch in the protected set:
  - `CANOPYCMS_BASE_BRANCH`;
  - GitHub's default branch, re-resolved with a 10-minute TTL;
  - a new optional `protectedBranches` list (exact names and `*` globs; CDK prop and env).

  It also never opens a PR whose head is protected. The PR `base` is **not** restricted to the
  protected set, which reverses v2. A branch records the base it was created from, and keeps it
  after the base changes (`branch-workspace.ts` L147, `api/github-sync.ts` L59). Restricting
  `base` would refuse every open branch's submit after an adopter moves its base, and it buys
  little: a PR merges nothing by itself, and its `pull_request` workflows run on the head's
  content whatever the base. `base` must still be an existing GitHub branch and pass
  `check-ref-format`.

  The base-branch and GitHub-default refusal already ships in single-process mode (#490,
  `RefusedPushError` in `github-mirror.ts`, with plain-name validation); the gateway keeps it and
  adds `protectedBranches` (PR 3). No legitimate flow pushes base: the only enqueuers are
  `services.ts` (settings) and `history-rewrite.ts` (rebased branches).
- **Settings branch.** Plain fast-forward pushes only: no lease, no delete, no PR.
- **`.github` and workflow files: not in this plan** (§11 D10). As today, whether a push that
  adds or changes a workflow file lands depends on the credential's scope: GitHub refuses it
  without `workflow` (PAT) or `workflows: write` (App) permission (`task-runner.ts` L661,
  `throwIfWorkflowRefusal`). The docs recommend such a scoped credential. Rounds 2–7 each found
  a bypass or a false positive in a gateway-side rule; D10 carries the best design reached.
- **Names and sizes.**
  - Branch names must pass `git check-ref-format --branch`, are normalized (a leading
    `refs/heads/` is refused, not stripped) before matching the protected set, and are
    length-capped.
  - Branch names are validated in node first: ASCII printable, no `"`, `%`, `{` or `}`, and no
    leading `-`. Then `git check-ref-format --branch <name>` runs bare. It takes exactly one
    argument and rejects `--end-of-options` (round 4).
  - Every other gateway git invocation puts `--end-of-options` before its positionals.
  - The gateway log escapes every non-printable character in request fields, including bidi
    controls, not only `\n`.
  - Refspecs are always fully qualified.
  - PR text fields are capped.
- **Egress redaction.** Every response, header and log line passes `redactCredentials`, plus an
  exact-string scrub of every live secret in every form it takes:
  - the raw token;
  - `base64("x-access-token:" + token)`;
  - the full `AUTHORIZATION: basic …` value;
  - the Clerk key;
  - the App private key, scrubbed line by line (each base64 line of the PEM body, so the scrub
    survives JSON or log escaping), and any JWT (`eyJ…\.…\.…`), since the App JWT mints
    installation tokens.

  `redactCredentials` matches neither the base64 form, nor the `AUTHORIZATION: basic …` value,
  nor the Clerk key. The gateway log escapes `\n` in every request-supplied field, so a PR title
  cannot forge a log line. The gateway never runs `git config
  --list`/`-l` or any other command that dumps config: round 2 verified it prints
  `GIT_CONFIG_VALUE_0` verbatim. The canary sweep asserts none of the forms egresses.
- **Fetch throttle.** Only the GitHub fetch is coalesced, for 30 s **from its completion**. That
  covers one sync cycle (fetch → reconcile → settings push), so the settings push reuses it, and
  every push's joined fetch is usually free. Any push invalidates it, so a fetch after a push
  sees the push. A push's added latency is at most one incremental GitHub fetch, inside
  `taskTimeoutMs`. During a GitHub outage every push is `transient`, as it is today. The bundle is always computed for the caller's own
  `have`.
- **Bundle creation is bounded.** Each client has at most one pending outgoing bundle, and a new
  one replaces it. A job's own caller gets its bundle created inside the job's `exclusive`
  session, after the GitHub fetch. A caller that joins a **completed** job in the coalescing
  window gets its bundle created in an `exclusive` session of its own. A loop of `fetch({ have: [] })`
  cannot fill the state directory.
- **One writer of the mirror's refs at a time.** The mirror's `exclusive` session is held by:
  - the fetch job: its git, and then its bundle creation;
  - every push, **from its reachability test to its last git command**, so the mirror's heads
    cannot move between reachability, policy and push;
  - the corruption rebuild (§3.3 step 5), which removes the alternate a quarantine reads, and so
    must never run beside an ingest;
  - the start-up sweep below.

  **A maintenance mutex** (gateway-internal) is held by self-scheduled maintenance for its whole
  sequence, in this order:
  1. `repack -a -d --cruft`;
  2. `commit-graph write --reachable`;
  3. `pack-refs --all`, last, as `repackBareRemoteIfNeeded` does today (`git-manager.ts`
     L220–221).

  Maintenance takes **only** the mutex, never `exclusive`. Sessions never take it, so pushes
  still run beside maintenance. **One lock order everywhere: `exclusive`, then the mutex.**
  - The on-failure sweep try-acquires the mutex inside `exclusive`.
  - The corruption rebuild runs **inline, as a plain call, in the session that detected the
    corruption**, with a backoff: after a failed rebuild, sessions report `transient` without
    retrying it for 5 minutes, so an outage does not trigger a full fetch per session. It runs
    in the session that already holds `exclusive` (detection happens in `create()`, which runs
    inside `exclusive`'s `start`, `github-mirror.ts` L55–59). There it waits on the mutex. It
    never calls `exclusive` itself: `exclusive` chains on `this.tail`, so a nested call would
    wait on itself and wedge every session. A PR 2 test: corruption detected at session start
    rebuilds, and the next session proceeds. A long wait there only delays pushes until
    maintenance ends.
  - Maintenance never calls `ensure()` or anything else that takes `exclusive`. Today's
    `maintain()` begins with `ensure()` (`github-mirror.ts` L104); the port drops that, or the
    rebuild deadlocks against it. A PR 2 test runs a rebuild during maintenance.
  - **Cadence:** after a fetch job's session is released, maintenance starts **detached** (never
    as a plain call inside the session, which would hold `exclusive` for a repack). It repacks
    only when the pack count exceeds today's threshold, and at most once per 10 minutes. Each
    git it runs has a generous **wall-clock** bound, not an inactivity one: round 11 verified
    that `repack -a -d --cruft`, `commit-graph write` and `pack-refs` write nothing to a pipe, so
    an inactivity timeout would kill every real repack. Maintenance never holds `exclusive`, so
    a long one is harmless. A killed maintenance run removes its own temporaries. The size
    warning check runs after every completed fetch job, outside the pack-count gate, as today's
    `maintain()` checks size on every call (`github-mirror.ts` L108–117).

  **Why the mutex exists:** `pack-refs --all` holds `refs/heads/<x>.lock` and
  `packed-refs.lock`, and a fetch beside it fails with exactly the sweep's trigger text. A
  sweep that ignored maintenance would unlink a live lock; round 7 traced the result to a
  truncated `packed-refs`.

  **Maintenance runs beside sessions, as today** (`github-mirror.ts` L27–30): `repack -a -d
  --cruft` expires no cruft, so no object a session is reading disappears. git re-scans packs
  on a missing pack. Round 6 verified that a reader holding an unlinked pack keeps reading it
  (`packfile.c` `fill_pack_entry` → `is_pack_valid` → `reprepare_packed_git`). The ingest never
  writes the mirror, so no before/after pack accounting exists to race. Holding `exclusive` for a full repack of a large mirror on a t4g.nano would
  stall pushes past the 60 s task deadline. The gateway self-schedules the sequence; the worker
  no longer calls `maintain()` (`git-sync.ts` L490), and the
  size warning moves to the gateway log.

### 3.3 Objects across the boundary

Verified on git 2.50.1, which is AL2023.12's version (§10):
- `git bundle create <sha>` is refused: a bundle needs a ref.
- A ref whose tip is excluded is dropped silently, so the ref map travels as JSON.
- An all-excluded bundle is refused ("empty bundle").
- A missing prerequisite fails cleanly.
- `create -` and `unbundle -` stream.
- `unbundle` updates no refs.
- `fetch.fsckObjects` applies to `git fetch <bundle-file>`.
- `unbundle` has no fsck option.

**GitHub → `remote.git`.** The worker calls `fetch({ have })`, then GETs the bundle. The gateway:
1. fetches GitHub into the mirror, coalesced;
2. filters `have` to the commits the mirror holds;
3. bundles `refs/heads/* ^have` into its state directory.

The worker:
1. pipes the response straight into `git bundle unbundle -` in `remote.git`, under the pins;
2. moves `refs/remotes/github/*` (`GITHUB_TRACKING_REF_PREFIX`, `git-manager.ts` L307) to the
   JSON map, replacing `--prune`, in **two** `update-ref --stdin` transactions:
   - all deletions first;
   - then all creates and updates.

   Each update carries its expected old value. A single transaction cannot do it: round 2 and I
   verified that deleting `a` and creating `a/b` together fails on a directory/file conflict,
   loose or packed, and that `--stdin` is all-or-nothing. A GitHub-side `release` → `release/1.0`
   would otherwise freeze the namespace for ever. If a batch fails (a lost race on one old
   value), the worker falls back to per-ref updates and logs the losers, which the next cycle
   retries. The Lambda only reads this namespace (`bareRemoteHasBranch`, `git-manager.ts`
   L807), so per-ref atomicity is all it needs.

The worker does not fsck. Its peer is the trusted side, and the objects came from GitHub.

`ensureRemoteGit`'s first seed is `fetch({ have: [] })` into the staging directory.
remote-git-self-heal's re-seed becomes the same call (§7).

**`remote.git` → GitHub.** The worker:
1. reads `sha` from `refs/heads/<branch>`;
2. sends the JSON-only `push` with `prerequisites`: the tracking tips of the branch and of base;
3. on `need-objects { usable }`, runs `git bundle create - refs/heads/<branch> ^<usable…>`;
4. checks that the bundle's head equals `sha`. If the Lambda moved the ref in between, the whole
   push restarts from `readPublishedSha`, because the [SYNC-H1] marker and lease logic depend
   on `sha`. At most 3 restarts, then it fails transient, so an attacker moving the ref every
   pass cannot livelock a task;
5. streams the bundle in.

A fresh gateway, whose mirror is new at every instance boot, answers with a smaller `usable`,
so no retry ladder is needed.

**Bundle intake in the gateway.** This is the hostile-input path.
- Round 1 verified that a filtered bundle leaves a `.promisor` pack in the receiving repository
  even when the fetch fails.
- Round 3 verified that a failed fsck leaves its pack.
- Round 4 reproduced a before/after pack cleanup racing a repack and deleting the consolidated
  pack, which left every head dangling.

So **pushed objects never enter the mirror.** Each ingest gets a fresh bare **quarantine**
repository, `/var/lib/canopy-github/incoming/<random>.git`:
- created by the gateway, with the mirror's pins **minus `core.alternateRefsCommand=true`**. That
  pin exists because `remote.git`'s alternates file is Lambda-writable; this one is
  gateway-written. With the pin, the fetch's connectivity check cannot stop at the mirror's
  heads and walks the whole repository per push (round 5 measured 10 057 objects vs 6);
- reading the mirror's objects through `objects/info/alternates`. Read-only use: git never
  writes into an alternate;
- deleted whole, `rm -rf` of a gateway-created path, on every exit path.

I verified on 2.50.1 that a bundle whose prerequisites exist only in the mirror fetches into
such a repository, that the push to the remote goes out from it, and that a failed ingest left
the mirror untouched.
1. **Stream to a file.** The body goes to `/var/lib/canopy-github/incoming/<random>.bundle`, capped
   (default 1 GiB, configurable). One at a time.
2. **Parse the header in node before git sees it.**
   - Accept only `# v2 git bundle` or `# v3 git bundle`.
   - The only allowed capability is `@object-format=sha1`; `@filter` is refused.
   - Exactly one head line: byte-equal to `<sha> refs/heads/<validated branch>`, which is what
     the worker's `bundle create refs/heads/<branch>` always writes. Anything else is refused
     before git runs.
   - The signature, capability, head and blank lines end in LF only. A prerequisite line's
     comment is opaque bytes: a commit subject can end in `\r`, and must not make a legitimate
     boundary commit refuse every later bundle.
   - **Bounded:** at most 64 KiB is read for the header, and the blank line that ends it must
     fall within that. A crafted "line" cannot make the gateway buffer the whole 1 GiB body.
   - **Prerequisite lines** match `^-[0-9a-f]{40}( [^\n]*)?\n`. `bundle create` writes
     `-<oid> <commit subject>`, and the subject is raw, attacker-chosen bytes (round 8 verified a
     tab, `"` and non-UTF-8 there). The comment is ignored and never logged unescaped. The object
     ID must be a commit the mirror holds, reachable from a `refs/heads/*` tip. That is checked with
     **one** walk for all of them, `git rev-list --stdin` fed the prerequisites plus a `^<tip>`
     line per head, **after** one `cat-file --batch-check` over the prerequisites requires each
     to print `<oid> commit`. Round 11 verified that `rev-list` passes a tree or blob ID
     silently, and `git fetch` of a bundle with a tree prerequisite succeeds. Each line's
     40-hex validation is load-bearing too: `rev-list --stdin` honours pseudo-options such as
     `--all`. With that: empty output means all are reachable, and an error means one is missing or
     not a commit. Round 10 verified that several `--contains` arguments mean "any", not "all". They are **not** required to be a subset of `usable`: round 3
     verified that `bundle create … ^X` writes the boundary commits (the fork point), not `X`.
3. **Fetch it into the quarantine:**
   `git -c fetch.fsckObjects=true -c fetch.fsck.hasDot=error -c fetch.fsck.hasDotdot=error -c fetch.fsck.hasDotgit=error fetch --end-of-options <file> refs/heads/<branch>:refs/canopy/outgoing/<branch>`
   (the severity pins are depth, since index-pack already errors on these by default),
   a fixed literal built from the validated branch. Round 3 verified that a header refname such
   as `--filter=blob:none` placed in argv is parsed as an option and plants
   `remote.<file>.promisor` and `partialclonefilter` in the receiving repository's config.
   Afterwards the gateway checks that the staging ref equals `sha`; otherwise it refuses.
   The gateway's git always runs with `GIT_NO_LAZY_FETCH=1` and `GIT_NO_REPLACE_OBJECTS=1`, so
   no `refs/replace/*` can change what any gateway git sees (depth: nothing writes one into the mirror).
4. **Clean up on every exit path:** the bundle file and the whole quarantine repository.
5. **Treat corruption in the mirror as a reason to rebuild it.** It cannot come from an ingest
   any more, but the check stays as depth. Under `exclusive` and the maintenance mutex, the
   gateway rebuilds the mirror from GitHub, at a full fetch's cost, into
   `github.git.rebuild`. Only once that succeeds does it swap: `github.git` → `github.git.old`,
   then `github.git.rebuild` → `github.git`, then `rm -rf github.git.old`. A directory cannot be
   `rename(2)`d onto a non-empty one, so this is not a single rename. A failed rebuild leaves
   the old mirror rather than none. At start, after a crash between the renames:
   - **`github.git` is absent and `.rebuild` exists:** the swap began only after the rebuild
     succeeded, so `.rebuild` is the good mirror and `.old` the corrupt one. It completes the
     swap: `.rebuild` → `github.git`, then `rm -rf .old`;
   - **`github.git` is absent and only `.old` exists** (it cannot happen by the sequence above,
     but as a fallback): `.old` is restored, and the corruption check decides;
   - **otherwise:** leftover `.rebuild` and `.old` are removed. While
   `exclusive` is held no quarantine is live, so swapping the alternates' target is safe. It does so
   if any of these appears:
   - a `refs/heads/*` whose object is missing (`for-each-ref` → `cat-file --batch-check`),
     which `isBareRepository` cannot see;
   - a `*.promisor` file;
   - `extensions.partialClone`;
   - any `remote.*.promisor` or `remote.*.partialclonefilter` key, read with
     `git config --get-regexp`, never `-l`.
   `create()` gains that check beside its bare-repository one.

**What this boundary guarantees.**
- The gateway never runs git outside `/var/lib/canopy-github`.
- The mirror's objects come only from GitHub.
- The gateway never opens a path a request names.
- `pinnedUploadPack` and `pinnedReceivePack` leave `github-mirror.ts`. The worker keeps them
  where it is both ends (clone ↔ `remote.git`).

**The cost.** The mirror is on the root volume, and every bundle roll replaces the instance.
- A new gateway can no longer seed itself from `remote.git`, so it fetches the whole repository
  from GitHub once per instance.
- The first seed's `fetch({ have: [] })` also writes a whole-repository bundle beside the mirror
  until the worker downloads it. GitHub → worker is staged, not streamed; worker → gateway
  streams. Say so in "The worker instance" and in the
`worker-github-mirror-limits.md` task.

### 3.4 The credential in the gateway

The token never enters argv, **and never enters the environment of a process that handles
hostile bytes:**
- **git:** before each GitHub-bound command (the GitHub fetch, and the push to GitHub), the
  gateway creates a config file in its `StateDirectory` (`0700`, and already checked by
  `assertOwnDirectory`): `mkdtemp`, then an exclusive `0600` create. The file is
  `[http "<origin of remoteUrl>/"] extraheader = AUTHORIZATION: basic
  <base64(x-access-token:TOKEN)>`. The gateway passes `GIT_CONFIG_GLOBAL=<that path>` to that
  command only, then deletes the file; the start-up sweep removes leftovers.
  - **Not `PrivateTmp`:** it is tmpfs only if the host's `/tmp` is, and in single-process mode
    it is the shared `os.tmpdir()`.
  - **The file must exist before the spawn:** a `GIT_CONFIG_GLOBAL` naming a missing file is a
    hard error.
  - **simple-git refuses `GIT_CONFIG_GLOBAL` in `.env()`** without `allowUnsafeConfigPaths`
    (`@simple-git/argv-parser` 1.1.1, under `simple-git` 3.36.0). That opt-in is enabled
    **only** on the instance that runs the two GitHub-bound commands, never in
    `mirrorGitOptions()` generally. A PR 1 test asserts every other gateway git still has the
    block.
  - **In dev mode**, `GIT_CONFIG_GLOBAL` replaces a developer's own global config for those two
    commands, so a global `http.proxy` or `sslCAInfo` stops applying to them. Environment
    proxies still pass through. This is documented. This is the scheme `actions/checkout` uses. Verified on 2.50.1: the value
  is read as global scope, and appears in neither the traced argv nor the environment, which
  holds only the path. The remote URL is the bare `https://github.com/<owner>/<repo>.git`.
- **Why not the environment** (round 10, read in systemd v252 `coredump.c`):
  - when a process crashes, `systemd-coredump` journals its `/proc/PID/environ` as
    `COREDUMP_ENVIRON` (L1280–1281, L915), even when `LimitCORE=0` refuses storage (L368–376,
    then `goto log` at L796);
  - the kernel runs a piped `core_pattern` whatever RLIMIT_CORE says (v6.1 `fs/coredump.c`
    L582, L645);
  - the worker runs with `ec2-user`'s supplementary groups (initgroups), which on AL2023
    usually include `adm`, `wheel` and `systemd-journal`, so it can read the journal.

  So a crash of the quarantine's `index-pack` on hostile bytes (R3) would have journaled an
  environment-borne credential where the worker could read it. A path is harmless there. Three
  further layers:
  - the node gateway never puts the credential in `process.env`, since a node `abort()` is the
    same leak;
  - the worker unit (and the inspect constant) gets
    `InaccessiblePaths=/var/log/journal /run/log/journal`;
  - user-data writes `/etc/sysctl.d/99-canopy.conf` (`kernel.core_pattern=core`,
    `fs.suid_dumpable=0`). It sorts after `/usr/lib/sysctl.d/50-coredump.conf`, and user-data
    then runs `sysctl --system`, because `systemd-sysctl` has already run by the time cloud-init
    does. It also adds `/etc/systemd/system.conf.d/canopy.conf` with `DefaultLimitCORE=0`, since
    PID 1 otherwise gives services an unlimited core limit, and a non-piped pattern would leave
    `core` files from any crashing daemon (round 11). The documented consequence: no core dumps
    on this instance;
  - **the gateway's boot self-check** fails closed unless `/proc/sys/kernel/core_pattern` does
    not begin with `|` and `/proc/self/limits` shows a zero core limit. These are host-global
    sysctls, so a container cannot test them (round 11), and this check is what proves the layer
    on a real instance.

  **Residual (R3):** git's config machinery loads the credential file into **every** child of a
  GitHub-bound command, including the GitHub fetch's `index-pack` and the push's
  `pack-objects`, which read quarantine objects (round 11, verified with trace2). That is heap
  memory only, not the environment or argv. Reaching it needs a core dump (disabled, and
  checked) or remote code execution in git, which could read the file during the command anyway.
  A credential helper would confine the value to `git-remote-https`, but gains nothing against
  such code running as the same uid.
- **Process environment:** `/proc/PID/environ` is 0400 and gated by ptrace access, unlike
  `cmdline` (0444).
- **Removed:** `buildGitHubUrl`. `redactCredentials` stays as depth.
- **Never dumped:** no config-listing command, and no `GIT_TRACE*`, `GIT_TRACE2*` or
  `GIT_CURL_VERBOSE` passed through (`trace2` `def_param` prints config values). Round 2 verified that git redacts the header in curl traces anyway.

### 3.5 What each side must never trust

**The gateway** trusts only the validated fields above and bundle bytes, which it treats as
hostile objects (§3.3 intake). It:
- never runs git anywhere but its own state directory;
- never `exec`s anything a request names;
- has no EFS (`InaccessiblePaths=/mnt/efs`, plus `RequiresMountsFor=/mnt/efs`, so the mount
  exists before its namespace is set up and a later host mount cannot propagate over the
  inaccessible node). It checks at boot that `/mnt/efs` is unreadable;
- sends no secret back;
- reads its own env file, `/opt/canopy-worker/gateway.env`, mode `0640 root:canopy-github`. It
  holds the secret ARNs and JSON fields, the App id and installation id, and the owner and repo.
  user-data creates it with `install -m 0640 -o root -g canopy-github` **after** `useradd`, so
  it is never briefly world-readable. `ec2-user` is not in the group.

**The worker** trusts the gateway's answers, and nothing on EFS more than today:
`assertSharedRepoConfig`, the pins and the content-write lock all stay.
- **Base branch:** it keeps today's resolution (#475's W1). If its base is not in the gateway's
  protected set, it logs a warning; it does not refuse. Refusing would turn a GitHub
  default-branch change, which `worker-boot-default-branch-refresh.md` records, into a boot loop.
- **Secrets in its environment:** in split mode it refuses to start if
  `CANOPYCMS_GITHUB_TOKEN*`, `CANOPYCMS_GITHUB_APP_*` or `CLERK_SECRET_KEY*` is set, so a hand
  install cannot put a secret into a process the attacker can become. That deliberately includes
  the ARN and JSON-field variables: they move to `gateway.env`. A hand v2 unit still pointing at
  the old `.env` stops on this, by name.

### 3.6 Module moves

**Credentialed (core):**
- `github-mirror.ts`: loses `fetchFromRemoteGit`, `publishTrackingRefs`, `seedBareRepository`
  and `pushToRemoteGit`. Gains `bundleFor(have)`, `withQuarantine(file, branch, sha, fn)`, the
  fetch job, self-scheduled maintenance, and the corruption check. `MIRROR_PINS` moves here.
- `github-auth.ts`: unchanged, apart from feeding the env-based credential.
- New `github-gateway.ts`: the `GitHubGateway` interface, `createLocalGitHubGateway`, the policy,
  and the refresh triggers.
- New `github-gateway-http.ts`: `serveGitHubGateway` and `connectGitHubGateway`.

**Unprivileged (core):**
- `worker-context.ts`: `github: () => GitHubGateway` replaces `octokit`, `buildGitHubUrl`,
  `githubMirror` and `refreshGitHubCredential`.
- `task-runner.ts`, `git-sync.ts`, `rebase.ts` (`pollMergeState`) and `github-service.ts`'s
  worker use.
- `cms-worker.ts`: `ensureRemoteGit` and `resolveBaseBranch` go through the gateway.
  `ensureGitHubAuth`, `octokitClient`, `buildGitHubUrl`, `preflightGitHubAppAuth`,
  `refreshGitHubCredential` and `ensureStateDirectoryIsPrivate` move into
  `createLocalGitHubGateway`.
- `shared-repo-git.ts`: worker-only.

**CDK entry (`canopycms-cdk/worker`):**
- `run.ts` splits into `runWorker`, which reads no secrets, and `runGateway`, which owns
  `secrets.ts`, `github-app-auth.ts`, `credential-refresh.ts`, the Clerk fetch half and
  `termination-watch.ts`.
- `index.ts` dispatches on `argv[2]`.
- One bundle, one sha256 check.
- `@octokit/auth-app` stays out of `canopycms` (worker/AGENTS.md).

**`canopycms-auth-clerk`:** `refreshClerkCache` splits into `fetchClerkSnapshot`, which the
gateway runs, and `writeClerkSnapshot`, which the worker runs to put the snapshot on EFS.

**Exports:** `serveGitHubGateway`, `connectGitHubGateway` and `createLocalGitHubGateway` are
re-exported from `canopycms/worker/cms-worker` (as `log.ts` is). No new entrypoint. It is still
new exported surface, so it needs JP's approval (D5).

## 4. The second user and EFS

**One new user,** `canopy-github`. user-data creates it with
`useradd --system --no-create-home --shell /sbin/nologin`.

`DynamicUser=yes` was rejected because the uid must exist **before** the service runs:
- user-data writes `gateway.env` with `install -g canopy-github`;
- the root-owned log directory's file and the mirror's state need a stable owner across
  restarts.

A dynamic uid exists only while its unit runs, and is recycled. (D8 records the alternative.)

**EFS: nothing changes.** The gateway has no EFS, and the worker keeps uid 1000 and the existing
access point:
- `posixUser` stays 1000;
- no second access point;
- no `safe.directory` change.

**canopycms-cdk changes:**
- user-data: the user, two new units, `gateway.env`, the worker unit's cut, and boot-time
  selection (§7);
- the CloudWatch agent tails `/var/log/canopy-github/gateway.log` as a second stream, which the
  worker cannot write;
- the checked-in copies of all three units;
- contract 2.

IAM is unchanged.

## 5. The network cut and IMDS

**Worker unit,** on top of `WORKER_SANDBOX_DIRECTIVES` (which already include
`ProtectProc=invisible` and `ProtectHome=tmpfs`):

| Directive | What it does |
| --------- | ------------ |
| `PrivateNetwork=yes` | Only `lo`, so no route to 169.254.169.254. |
| `IPAddressDeny=any` | eBPF filter. systemd says it silently does nothing without cgroup-BPF. |
| `RestrictAddressFamilies=AF_UNIX` | Restricts `socket()` only. libuv's child stdio uses `socketpair`, which this leaves alone. |
| `PrivateIPC=yes` | Its own IPC namespace. |
| `InaccessiblePaths=-/run/dbus -/dev/shm -/var/log/journal -/run/log/journal` (a `-` on **each** path: it covers only the path it prefixes, and a missing journal directory would otherwise fail the unit) | Hides the system bus socket, `/dev/shm` and the journal. The journal because the worker carries `ec2-user`'s groups, which can read it (§3.4). `PrivateDevices=yes` keeps `/dev/shm`, and `PrivateIPC=` covers only SysV IPC and mqueue, so `/dev/shm` would otherwise be the one directory both units and root can write outside EFS and `PrivateTmp` (v252 `systemd.exec.xml` recommends hiding it). Both units, and the inspect constant. |
| `LimitCORE=0` | Nothing is stored and no root-volume growth from repeated node cores. Both units. With a piped `core_pattern`, the kernel still runs the root helper (RLIMIT_CORE is irrelevant to pipes, kernel v6.1 `fs/coredump.c` L585–604), which gathers metadata from `/proc` before declining. None of that is worker-writable, so PR 6's `core_pattern` audit stays load-bearing; `Storage=none` in `coredump.conf` is an option. |
| `LogsDirectory=` **removed** | `/var/log/canopy-worker` becomes root-owned, and the user-data `chown` goes (§3.1). |
| `SystemCallFilter=@system-service` | **Verified in the container:** node 22 and git (init, commit, rebase, bundle) run under it on systemd 252. |

`ProtectHome=tmpfs` is **load-bearing**: per systemd 252, it makes `/run/user` inaccessible.
That shuts the `systemd-run --user` and user-bus escape when an admin is logged in as
`ec2-user`, so the container check tests it.

**Gateway unit:** the same sandbox list, plus:
- `InaccessiblePaths=/mnt/efs` and `RequiresMountsFor=/mnt/efs`;
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`, where `AF_NETLINK` is for
  glibc's `getaddrinfo`;
- `StateDirectory=canopy-github` with `StateDirectoryMode=0700` (the default is `0755`, which
  would let `ec2-user` read the mirror and the quarantines), and **no** `LogsDirectory=`: the log directory is root-owned (§3.1);
- `EnvironmentFile=/opt/canopy-worker/gateway.env`;
- its own contract stamp.

**Self-checks, fail closed.** In the CDK entrypoint at contract ≥ 2 they are unconditional (§7).
The worker at boot:
1. **IMDS:** a TCP connect to 169.254.169.254:80 with a 1 s timeout. `ENETUNREACH`,
   `EAFNOSUPPORT` (`RestrictAddressFamilies=AF_UNIX`) and a timeout all pass. If it connects,
   the worker refuses to start: "the worker unit can reach the instance metadata service, so the process
   split protects nothing".
2. **Network namespace:** `/proc/self/net/dev` lists only `lo`. **Not `/sys/class/net`:** the
   container run showed that `PrivateNetwork=` does not remount sysfs, so `/sys/class/net`
   shows the host's interfaces even inside the cut. This check is what catches a unit that
   kept `IPAddressDeny` but lost `PrivateNetwork`: the IMDS connect alone then only times out,
   which passes.
3. **`/proc`:** it lists `/proc` and refuses if it sees any process not owned by uid 1000. That
   check is `ProtectProc=invisible` taking effect.
4. **`/home` is empty:** `ProtectHome=tmpfs`'s always-observable effect. `/run/user` is empty
   anyway whenever nobody is logged in, so a check on it alone is vacuous (the container run
   showed that).
5. **Secrets in its env** (§3.5).

The gateway at boot checks that it cannot read `/mnt/efs`, and the core settings (§3.4).

**Why EFS survives `PrivateNetwork`.** From kernel v6.1 source:
- `nfs4_init_server` and `nfs_init_server` build the RPC client with `fc->net_ns`;
- `fs_context.c` L266 sets that from the mounting process's namespace;
- `client.c` L184 and L501 use `clp->cl_net`.

The mount happens in user-data, in the host namespace, so I/O from another namespace uses the
host-namespace transport, including efs-utils' TLS proxy on host loopback. Filesystem AF_UNIX
sockets stay reachable; abstract ones do not (systemd 252).

**Tests:**
- **Unit:** synth tests on all three units; the self-checks against a local listener and a fake
  `/proc`.
- **Container:** `amazonlinux:2023` under real systemd, with the units extracted from a synth:
  - with 169.254.169.254 on a dummy interface and a listener, the worker unit cannot connect;
    a plain unit can;
  - the worker reaches the socket; a third user cannot;
  - the worker's `/proc` shows no `canopy-github` process;
  - the gateway cannot see `/mnt/efs`, including after a later bind mount there;
  - neither unit can see `/dev/shm`;
  - `systemd-run`, and `systemd-run --user` with an `ec2-user` session open, both fail from the
    worker;
  - `systemd-analyze security` scores both units;
  - rebase and bundle work under the worker unit;
  - node and git work under `@system-service`.
- **First real deploy:**
  - EFS read/write from the worker unit;
  - IMDS unreachable from it;
  - `ss -xlp` for any listening filesystem socket uid 1000 can use;
  - the App preflight;
  - the per-instance full mirror fetch time.

## 6. Dev mode: one implementation

`createLocalGitHubGateway(config)` is the only implementation of each operation, policy
included.

**Single-process mode** passes it to `CmsWorker` directly. That covers dev, `canopycms worker`,
a custom entrypoint, `apps/test-app`'s e2e route, and CDK entrypoints below contract 2.

**Split mode** wraps the same object:
- the gateway runs `serveGitHubGateway(createLocalGitHubGateway(cfg), { fd: 3 })`;
- the worker runs `connectGitHubGateway(socketPath)`.

Bundles are the transfer in both modes, so dev and CI exercise production's object path.

**Tests:**
- A contract suite runs every operation against `local` and against `client → server → local`
  over a real socket.
- The GitHub-touching worker suites gain a split-mode run.

## 7. Rollout

**Contract 2.** It appends to req-106's `WORKER_CONTRACT_REQUIREMENTS`
(`feat/worker-template-contract`): "`canopy-github.socket` and `canopy-github.service`, and
`CANOPYCMS_GITHUB_GATEWAY_SOCKET` on the worker unit". In the CDK entrypoint, a bundle at
contract ≥ 2 **requires** the socket variable and runs split, with the self-checks
unconditional. There is no single-process fallback there, so a mis-stamped hand unit fails
loudly instead of silently running with the credential.

**Why the template cannot cut unconditionally.** "Template first" means the new template runs
the **old** bundle until CI rolls the new one, and an old bundle in a network-cut unit cannot
reach GitHub.

**Boot-time selection.**
- The bundle carries `// canopy-worker-contract: N` within its first 5 lines. esbuild emits the
  `#!/usr/bin/env node` hashbang first, and `package.json` L36 already has a `--banner:js`
  (the `createRequire` shim) that this merges into. user-data matches `^// canopy-worker-contract:
  [0-9]+$` in `head -n 5`, not line 1. N comes from `WORKER_CONTRACT_VERSION`, the same source as
  106's `index.js.contract`, never a literal. A PR 6 test builds the bundle and asserts the line.
  No line means ≤ 1.
- After the sha256 check, user-data reads that line, so it is as trusted as the bundle:
  - **N ≥ 2:** it writes the user, `gateway.env`, the socket and both split units. The worker
    stamp is 2.
  - **Otherwise:** it writes today's single unit, stamp 1, and nothing else.
- Every bundle roll replaces the instance, so each boot is self-consistent.
- **The trust is deploy authority, not a signature.** In `workerCode: { source: 'parameter' }`,
  whoever can set the parameter chooses both the bundle and its pinned sha256, so the banner is
  exactly as trusted as that authority, which is already root on the instance.

| Template | Bundle | Result |
| -------- | ------ | ------ |
| new | old | runs as today |
| new | new | split |
| old | new | 106's "template too old" line |
| new | rolled back to old | unsplit, working |

The adopter-migration entry is **Template first**.

**Hand-installed units.**
- `canopycms-cdk/worker/` ships `canopy-worker.service` (v2), `canopy-github.service`,
  `canopy-github.socket` and a `gateway.env` example.
- The steps are `useradd`, the files, then
  `systemctl enable --now canopy-github.socket canopy-github.service canopy-worker.service`.
- Each kind of mistake stops loudly:

  | Mistake | Stops on |
  | ------- | -------- |
  | An old unit under a v2 bundle | the contract line |
  | A v2 stamp with no socket variable | the contract-2 requirement |
  | A unit without the cut | the IMDS self-check |
  | A unit without `ProtectProc` | the `/proc` check |
  | Secrets in the worker's env | the env check |

**Coordination:**
- **106** merges first. PR 6 builds on its `WORKER_CONTRACT_REQUIREMENTS` and adds the banner.
- **105** (user-data swap and retries) touches the same user-data; PR 6 rebases on it.
- **remote-git-self-heal** reworks `ensureRemoteGit`; PR 2 ports its re-seed onto `fetch`.
- int is re-read before PR 1.

## 8. PRs, in order, into `int-202610-b`

**What reaches production when.** PRs 2 and 3 change single-process behaviour, which every
adopter runs until PR 6: bundles replace the local fetch and push, and policy refuses
protected-branch pushes. Each carries its own adopter-migration line. The Fable
full-diff review runs before the first int that carries PR 2, then again over PRs 4–6 before
the int that carries PR 6.

| PR | Contents | Tests | Tier |
| -- | -------- | ----- | ---- |
| 1. Interface and local implementation | Defines the **final** `GitHubGateway` interface: `push({ branch, sha, lease, prerequisites }, bundle?)` with the `need-objects` answer, the `fetch` job, every `pr.*` op, etc. `createLocalGitHubGateway` implements it, still moving objects through `remote.git` internally. `WorkerContext.github()`. The credential moves to a per-command `GIT_CONFIG_GLOBAL` file in the gateway's `PrivateTmp`, given only to GitHub-bound git (§3.4); never to `process.env`. A test: the environment of every spawned git, and of the node process, holds no form of the secret. | A test-corpus rewrite, budgeted as one: every `cms-worker*.test.ts` stubs `buildGitHubUrl` and `octokit` today (`worker-context.ts` L17–24). PR 1 also deletes the worker-side refresh triggers (`task-runner.ts` L291, `cms-worker.ts` L1449), adds the join and the arming rule (§3.2: GitHub- and Clerk-bound failures arm it; local refusals do not). `createLocalGitHubGateway` takes a `remoteUrl` (default `https://github.com/{owner}/{repo}.git`). The suites that prove push classification against real git output use the **real** local gateway pointed at a bare fixture: `cms-worker.test.ts` L900–949, `cms-worker-rebase-publish`, `-github-app-auth`, `-credential-refresh`. Only suites that never reach GitHub get a fake. | Opus |
| 2. Bundle transfer | The mirror never runs git outside its directory. Bundle intake hardening and the push-identity invariant. The ref map as two `update-ref` transactions with a per-ref fallback. The `need-objects` push after a joined fetch. The quarantine. The coalesced fetch throttle. Self-scheduled mirror maintenance **beside** sessions, with `commit-graph`, under the maintenance mutex (repack, commit-graph, `pack-refs` last). The start-up sweep, and the on-failure sweep (try-acquire, skip when maintenance holds the mutex). The header bound and the prerequisite-line grammar. `GIT_NO_LAZY_FETCH`/`GIT_NO_REPLACE_OBJECTS` on every gateway git. The non-commit `sha` refusal. The corruption rebuild under `exclusive`. The boot pre-fetch. The per-client bundle bound. Seed and self-heal through `fetch`. The three-way `cat-file --batch-check` branch; one `rev-list` reachability walk for prerequisites; the rebuild inline in the detecting session; detached maintenance and the size warning after every job; a joiner's bundle in its own session; lock-text failures never arm the refresh. | Spawn spy: the gateway's git never has a cwd or `GIT_DIR` outside its state dir, and every invocation carries `--end-of-options`, except `check-ref-format --branch`, which takes exactly one argument. A branch forked below `usable` (boundary prerequisites). A failed ingest leaves the mirror byte-identical. A repack running during an ingest leaves every head resolvable (the round-4 reproduction). A dangling head is detected as corruption. Each sweep target planted, then restart, and the fetch succeeds. A fetch failing with the lock text during maintenance returns `transient` within a bound and sweeps nothing. A rebuild that fails leaves the old mirror; leftover `.rebuild`/`.old` names are swept. A prerequisite line with a tab and non-UTF-8 subject is accepted; a 2 MiB header line is refused without buffering it. A blob `sha` is `refused-by-policy`. A ref moved during bundling restarts the push at most 3 times, then fails `transient`. A second `need-objects` fails `transient`. Corruption detected at session start rebuilds, and the next session proceeds. A crash-recovery start with only `.rebuild` completes the swap. The spawn spy also asserts the two `GIT_NO_*` variables. A push during a failed GitHub fetch is `transient`. A prerequisite that vanished after the joined fetch gives `transient`. A push never deadlocks on `exclusive`. The quarantine's connectivity walk is bounded (rev-list spawn spy on a deep fixture). A header refname of `--filter=blob:none` is refused before git runs. `remote.*.promisor` config is detected as corruption. Hostile bundles: `@filter`, a blob head, a wrong head, oversize, a promisor plant. `need-objects` on a fresh mirror. A D/F rename (`a` → `a/b`). An ancestor push → non-fast-forward → `PermanentTaskError`. Up-to-date push with no body. Extra, space-embedded or renamed header refs. Break and re-run every new test. | Opus |
| 3. Policy | Protected set with TTL, `protectedBranches`, the PR head rule, the settings rules, branch-name validation, egress redaction, the gateway log's escaping of non-printables, the worker's base-not-protected warning (§3.5). | One test per rule; a canary sweep over every secret form (§3.2); a hostile worker's refusals never arm the credential refresh. | Sonnet |
| 4. HTTP transport | Server and client, zod, streaming bundle bodies, the fetch job and polling (gateway-side inactivity and low-speed kill, failed jobs never joined and completed ones reused, 10-minute bundle retention, the 10 000-`have` cap), `health`'s fields (protected set, `clerkConfigured`, preflight, fatal error), "gateway unreachable while draining" → `TaskAbortedForShutdownError`, abort propagation for push and ingest (never the fetch job), error envelopes rebuilt as Octokit-shaped errors. Re-exports. The self-check helpers. | The contract suite in both modes; split-mode worker suites; a push or ingest abort kills its git; a client abort leaves the fetch job running; unknown job id → new fetch. | Opus |
| 5. CDK entry roles | `runWorker` and `runGateway`. The worker's boot self-checks (IMDS, `/proc`, secrets in env), unconditional at contract ≥ 2. The gateway's SIGTERM handling (refuse new requests, finish push and Octokit requests, kill the fetch job). The termination poll. The Clerk fetch/write split. `health`'s fatal error recorded as `lastFatalError` (phase `startup`) by the worker. Inert until the socket variable exists. | `run.test.ts` for both roles; the Clerk refresher split. | Sonnet |
| 6. Template | The user, units, `gateway.env`, `StateDirectoryMode=0700`, `InaccessiblePaths=/dev/shm`, the gateway's `/mnt/efs` boot check, root-owned log directories (no `LogsDirectory=`), `LimitCORE=0`, the root-opened-path audit (incl. `socket_chown`, `core_pattern`), the `canopy-inspect` wrapper and reworded refusal messages, `build:worker` on the esbuild API, the cut, boot-time selection, the banner, contract 2, the CloudWatch stream, checked-in units. `kernel.core_pattern=core` and `fs.suid_dumpable=0` via sysctl.d; the journal directories hidden from the worker and the inspect shell. | Synth tests; a built-bundle banner test; the container checklist (§5) and the inspect checks (§9 R9), including the planted-log-symlink restart and the SEGV-with-canary case, with results in the PR body; `systemd-analyze security` before and after. | Opus |
| 7. Docs | Security Model, "The worker instance", adopter-migration, ARCHITECTURE, `worker/AGENTS.md`. Resolve the task; file the residuals. `docs/concurrency.md`'s mirror row (now two locks: `exclusive` and the maintenance mutex, one order). | `lint:docs`, `lint:tasks` | main loop |

No separate epic branch: int is the integration branch, and the review gates above stand in for
the epic PR.

**PR 1 ships as two PRs.** 1a: the interface, `createLocalGitHubGateway`, `WorkerContext.github()`
and the test corpus on `useLocalGitHubGateway`. 1b: the credential file, the refresh arming rule
and the join, and deleting the worker-side refresh triggers. 1a's interface has none of the bundle
parts yet (`push`'s `prerequisites` and body, `need-objects`, the `fetch` job). They arrive by
PR 2, their first user.

**Carried from 1a's reviews:**
- PR 2: `fetch` returns only `bundleId`. The ref map arrives with its first consumer, the
  `update-ref` transactions.
- PR 3: the gateway owns the protected-branch set. `push` takes `protectedBranches` from its
  caller today. The set must also guard `deleteBranch` and PR heads.
- PRs 2 and 4: these cannot cross a socket: `seedBareRepository`'s callbacks, the
  `remoteUrl` function, the live `GitHubPushError.cause`, and the `signal` inside a
  `createOrUpdatePullRequest` request.
- PR 4: `onGitHub` keeps its object-ID validation (`MirrorSession.isOnGitHub`) gateway-side,
  whatever the client checks.

## 9. Residual risks, and the Security Model afterwards

- **R1 — Gateway authority.** Through the queue and the worker, a compromised Lambda can still:
  - push to, lease-push and delete any branch outside the protected set, including branches it
    did not create (`release/*`, a developer's branch, a deploy-trigger branch);
  - open PRs from such branches, and push to them, which runs the adopter's `pull_request` and
    `push` workflows on attacker-chosen content;
  - push new or changed workflow files, **if the credential's scope allows** (as today; D10);
  - push **any commit GitHub already holds** (any historical base commit, any developer's tip)
    to such a branch, with non-workflow commits on top. Every workflow version in the
    repository's history can therefore run on attacker content, including old ones that put
    secrets in `env:`, or that use `pull_request_target` with a checkout of the head;
  - update, close, retitle or draft **any** PR by number (`pr.*` take a number from the task
    payload, `task-runner.ts` L381, L452, L471);
  - read every GitHub branch, and the Clerk snapshot that is already on EFS.

  - read the Clerk user directory through `authSnapshot` at will, which costs Clerk API quota,
    and end the instance's drain early through `completeLifecycle`. Neither is
    queue-requestable today;
  - push an object the mirror still holds but GitHub no longer references (say, a secret
    force-pushed away), by its object ID, into a commit, which the next fetch then copies to EFS.
    It needs the object ID, and GitHub itself retains such objects. `repack --cruft` with no
    expiry keeps such objects for the **instance's lifetime**: round 10 verified an orphan
    survives into a `.mtimes` cruft pack. The window ends only because each instance starts with
    a fresh mirror. An expiry would need `exclusive`, which maintenance must not take.

  Everything else in that list is possible today. The gateway newly refuses protected
  branches. Load-bearing outside it:
  - a credential without workflow-write scope;
  - GitHub rulesets on base;
  - workflows that grant `pull_request` and `push` runs only read-only `permissions:`;
  - environment-scoped secrets with required reviewers;
  - `on: push: branches:` limited to protected names, and no `pull_request_target` that checks
    out the head.

  D9 asks whether to narrow this with a CMS branch namespace; D10 asks whether to add a
  gateway-side `.github` refusal.
- **R2 — Local escalation from the worker unit.** Through kernel bugs, or `ec2-user`'s sudo,
  which `NoNewPrivileges` blocks. A future task: a dedicated non-login worker user.
- **R3 — Gateway parser bugs.** In git's bundle, index-pack and fsck code on hostile input (not
  new: today's mirror fetches Lambda-written objects), and in node's HTTP parser.
- **R4 — A sandbox directive that silently does not apply.** The self-checks cover the network
  and `/proc`. `IPAddressDeny` without BPF is covered by `PrivateNetwork`.
- **R5 — Denial of service.** The worker can:
  - fill the incoming cap, one at a time;
  - hit the fetch throttle, or, by pushing in a loop (each push invalidates the coalesced
    fetch), choose the gateway's GitHub fetch rate, within GitHub's own rate limits;
  - make every push wait, at most once per 5 minutes, for a credential refresh it armed with an
    Octokit error (`getSecret` can take 87 s): `transient` failures within the task deadline;
  - fake its own liveness log lines. The worker-down alarm counts `Syncing git...` in the
    worker's own output, so a compromised worker can keep it quiet while sync is wedged. The
    alarm detects faults, not compromise; the gateway log is the unforgeable record of what
    reached GitHub;
  - call `completeLifecycle` early, which cuts its own drain short.
- **R6 — Single-process deployments keep the race gap:** dev, custom entrypoints, `canopycms
  worker`. Documented.
- **R7 — Other filesystem AF_UNIX sockets** reachable by uid 1000. Audited at first deploy.
- **R8 — Root opening worker-controlled paths.** §3.1's rule, audited in PR 6. This is the class
  round 2's CRITICAL came from.
- **R9 — Operators touching EFS as root, or as an unsandboxed `ec2-user`.** That includes git
  (for example, following an `UntrustedRepoConfigError` message's advice) and any root write
  into `/mnt/efs`, since the client-side path walk follows the worker's symlinks.
  - **The exposure:** hostile config executed as an unsandboxed `ec2-user` can write
    `~/.bashrc`, and AL2023 gives `ec2-user` `NOPASSWD` sudo, so the next login is root, then
    the secrets. Round 3 showed a bare `systemd-run -p PrivateNetwork=yes` recipe is not a
    sandbox.
  - **The fix, in PR 6 and PR 7:** `canopy-inspect`, a root-owned wrapper in `/opt/canopy-worker`
    (which `ec2-user` cannot write: `install -D` as root, `ProtectSystem=strict`).
    - **Default mode,** for one command:
      `/usr/bin/systemd-run --pipe --wait --collect --uid=ec2-user --gid=ec2-user -p <each directive> -- /opt/canopy-worker/inspect-checks <command> <args…> </dev/null 2>&1 | cat -v`.
    - **`inspect-checks` is an exec wrapper:** it runs the assertions below, then
      `exec "$@"`, so the checks and the operator's command are **one sandboxed process**.
      Nothing after `--` is ever composed by a shell outside the sandbox. A `&&` there would
      run the command as the caller, unsandboxed, which rounds 9a and 9b both caught in v9's
      text.
    - **stdin is `/dev/null` and stderr joins stdout before `cat -v`.** `--pipe` passes the
      caller's file descriptors through (v252 `run.c` L776–781), so otherwise the sandbox could
      write raw escape sequences on stderr (OSC 52 clipboard write, title/DECRQSS queries) and
      read the terminal's replies on stdin.
    - **`--interactive`** is an explicit flag:
      `systemd-run --pty … -- /opt/canopy-worker/inspect-checks bash --noprofile --rcfile /opt/canopy-worker/inspect.rc -i`.
      Not `-l`: bash ignores `--rcfile` for a login shell (bash 5.2 `shell.c`
      `run_startup_files`). Its help text says a pty relays hostile escape sequences both ways,
      and to paste nothing from that terminal into a root shell.
    - **Directives:** exactly the worker unit's list. That is `WORKER_SANDBOX_DIRECTIVES`, plus
      every §5 addition (`PrivateNetwork`, `IPAddressDeny`, `RestrictAddressFamilies`,
      `PrivateIPC`, `InaccessiblePaths=-/run/dbus -/dev/shm -/var/log/journal -/run/log/journal`, `LimitCORE=0`), plus
      `ReadWritePaths=/mnt/efs`. One exported constant generates both lists. Round 5 read
      v252's `bus_append_*_property`: each is accepted as a transient property.
      `systemd-run` has no property-file option, and whether a drop-in applies to a transient
      unit is unverified, so the wrapper depends on neither.
    - **`inspect-checks` is a shell script, pinned:** `set -euo pipefail`; then
      `/usr/bin/node-22 /opt/canopy-worker/index.js self-check`, the worker's own boot
      self-checks in the same bundle, so there is one implementation; then the shell-level
      checks below; then `exec -- "$@"`. The `--` matters: round 10 verified that `exec "$@"`
      swallows a leading `-a`/`-c`/`-l` argument. The wrapper runs `systemd-run --quiet`, and
      `set -o pipefail` around `| cat -v`, so the refusal's exit status reaches the caller.
      Relative paths resolve against `/` (no `-d`), so nothing outside the sandbox resolves an
      EFS path.
    - **Assertions** (exit non-zero on any failure):
      - the IMDS connect fails (`ENETUNREACH`, `EAFNOSUPPORT`, or a timeout);
      - `/proc` shows only uid 1000;
      - there are no secret variables;
      - `/proc/self/net/dev` lists only `lo` (not `/sys/class/net`, which shows the host's
        interfaces);
      - `/home` is empty;
      - `/proc/self/status` shows `NoNewPrivs: 1` and `Seccomp: 2`;
      - `id -u` is 1000;
      - `/run/user` is an empty read-only tmpfs (`ProtectHome=tmpfs`, load-bearing per §5);
      - `/dev/shm`, `/var/log/journal` and `/run/log/journal` are inaccessible;
      - `sudo -n true` fails.
    - **Never `nsenter` or `machinectl`.** Entering namespaces does not inherit seccomp,
      `NoNewPrivileges` or the bounding set, so an `nsenter`ed `ec2-user` can `sudo` (round 4).
      The docs say so in those words.
    - **Container checks:**
      - **Positive:** `canopy-inspect id -u` prints `1000`; `canopy-inspect cat /proc/self/status`
        shows `NoNewPrivs: 1` and `Seccomp: 2`. Both are run as root, so a command escaping the
        sandbox would print `0`.
      - **Negative, one per assertion:** drop `PrivateNetwork`, then `ProtectProc`, then the
        seccomp-implying set, then `ProtectHome`, then the `/dev/shm` and journal
        `InaccessiblePaths`. Each time the wrapper must refuse and the command must not run.
        (systemd implies NNP from several directives, so dropping `NoNewPrivileges` alone proves
        nothing.)
  - **Messages and docs:** every refusal message, and the docs, say "inspect EFS only inside
    `canopy-inspect`; never read or write `/mnt/efs` as root". The `rm -rf` advice in
    `refusePopulated` and the `git config --unset-all` advice in `UntrustedRepoConfigError`
    are reworded to run inside it.

**Security Model text, replacing the race paragraph:**

> If the CMS Lambda is compromised, an attacker can read and write content on EFS. It has no
> internet route: it reaches only EFS and the AWS services its own role and VPC endpoints allow
> (the S3 asset bucket, as deployed). It can write the git state the worker reads, and by
> racing the worker it may run a command as the worker. The worker has no network, no
> credential and no route to the instance metadata service: the GitHub credential, the Clerk
> secret key and the instance role are used, among CanopyCMS's processes, only by a separate GitHub gateway service, which
> cannot see EFS and answers the worker through a fixed set of operations, such as: push or delete a
> branch, open or update a pull request, fetch from GitHub. Those are the operations the Lambda
> can already request through the task queue; the others are reading the Clerk user directory,
> and the instance's own lifecycle signals. The gateway refuses to push to, delete, or open a
> pull request from the base branch, GitHub's default branch, or any branch in
> `protectedBranches`. It can still push to other branches (including commits already in your repository, so any
> workflow in your history can run on its content) and open, update or close pull requests,
> which run your `push` and `pull_request` workflows. So protect your base branch with a GitHub
> ruleset, give workflows read-only `permissions:`, keep deployment secrets in environments
> with required reviewers, never check out a pull request's head in `pull_request_target`, and
> use a fine-grained token or an App **without** the workflows permission, which is what stops a
> push from adding or changing a workflow file. The
> worker's host, system git config and image stay trusted. A worker run as one process (dev
> mode, or an entrypoint of your own) does not get this separation.

The table becomes three columns: CMS Lambda, Worker, GitHub gateway.

## 10. Verification log

| Claim | How verified |
| ----- | ------------ |
| AL2023.12 ships git 2.50.1 and systemd 252.23 | AWS "AL2023.12 upgrades from AL2" package page |
| Bundle facts in §3.3 | Run on git 2.50.1 locally (me), and again by the round-1 reviewers |
| A filtered (`@filter`) bundle fetch fails but leaves a `.promisor` pack | Reproduced locally. Reviewer 1a also reports `repack`/`bundle create` dying afterwards, and a later fsck'd fetch storing incomplete history. Not reproduced in my smaller case; the plan treats the state as corruption either way. |
| `GIT_CONFIG_COUNT` config is command scope and never appears in argv | Run on 2.50.1 with `GIT_TRACE=1` |
| `PrivateNetwork=`, `ProtectProc=`, `RestrictAddressFamilies=`, `DynamicUser=`, `ProtectHome=` (incl. `/run/user`) semantics | systemd v252 `man/systemd.exec.xml` |
| `IPAddressDeny=` is ignored without BPF | v252 `systemd.resource-control.xml` |
| `SocketUser`/`SocketMode` | v252 `systemd.socket.xml` |
| The NFS RPC client uses the mount-time netns | Linux v6.1 `fs/nfs/client.c`, `nfs4client.c`, `fs/fs_context.c` |
| The token is in argv | `cms-worker.ts` L1308 → `github-mirror.ts` L183, L294 |
| No legitimate base push | `services.ts` L592, `history-rewrite.ts` L192 |
| `GITHUB_TRACKING_REF_PREFIX` = `refs/remotes/github/` | `git-manager.ts` L307 |
| `createOrUpdatePullRequest` uses GraphQL | `github-service.ts` L161, L216 |
| **Container run** (AL2023 image, systemd 252.23, git 2.50.1, node 22; units hand-written per this plan; fake IMDS on a dummy interface): the worker unit cannot reach IMDS, the host loopback or other users' processes (the gateway's argv canary is invisible), but does reach the gateway socket. Its log, `/opt`, `/etc` and the gateway's state are unwritable or unreadable to it; `/dev/shm`, both journals and the system bus are inaccessible; `systemd-run` (system and `--user`) fails; git init, commit, rebase and bundle work in `/mnt/efs` under `@system-service`. The gateway is uid `canopy-github`, cannot see `/mnt/efs`, and does reach IMDS. **Per layer:** `PrivateNetwork` alone gives `ENETUNREACH`; `IPAddressDeny` alone gives a timeout and the self-check refuses; with neither, the connect succeeds and the self-check refuses. **Log-symlink attack:** today's layout (worker-owned `LogsDirectory`) let uid 1000 make systemd create a root-owned `/etc/pwned-today` holding its output; the plan's root-owned layout refused 4 of 4 swap attempts. **`canopy-inspect`:** runs as uid 1000 with NNP and seccomp; `exec --` passes a leading `-n`; dropping `PrivateNetwork`, `ProtectProc`, `ProtectHome` or `InaccessiblePaths`, or every seccomp-implying directive, each makes it refuse with exit 1 before the command runs. Two self-check corrections came out of it (`/proc/self/net/dev`, `/home`). | Run 2026-10-10 on the chip's machine; units hand-written per this plan (scripts not committed) |
| **Not testable in a container:** `core_pattern`/`suid_dumpable` (host-global sysctls), EFS over NFS from a `PrivateNetwork` unit, IMDS on EC2. The `sudo` escalation demonstration was inconclusive: the image's sudoers asked for a password | the gateway's core self-check and the first real deploy (§5) |
| systemd 252 opens `append:` output as root, following symlinks, before the namespace and user switch | v252 `src/core/execute.c` L386–395, L4393, L4533, L4724, L4924 (read; the round-2 reviewer withdrew this, wrongly citing `ProtectSystem`) |
| systemd's recursive chown of exec directories does not follow symlinks | v252 `src/shared/chown-recursive.c` L74, L119 |
| One `update-ref --stdin` fails on a D/F rename; two transactions succeed | Run on 2.50.1 |
| `git config -l` prints `GIT_CONFIG_VALUE_0`; curl traces redact the header | Round-2 reviewer, on 2.50.1 (not re-run by me) |
| `bundle create … ^X` writes boundary commits (the fork point) as prerequisites, not `X` | Run on 2.50.1 (me, and reviewer 3b) |
| A failed fsck'd bundle fetch leaves its pack, so `sha` reads as a commit but cannot be pushed | Reviewer 3b on 2.50.1 (not re-run by me) |
| Options after the bundle path reach `git fetch` and plant `remote.*.promisor` config; `--end-of-options` stops it | Reviewer 3a on 2.50.1 (not re-run by me) |
| No root opener of a worker-writable path survives v3: exec dirs, PrivateTmp, `socket_chown` (follows symlinks, safe only because `/run/canopy-github` is root-owned), coredump, tmpfiles, logrotate, the CloudWatch agent, efs-utils' watchdog (reads `/var/run/efs`, `/proc/mounts` only) | Reviewer 3a: systemd v252 `fs-util.c`, `namespace.c`, `socket.c`, `coredump.c`, `tmp.conf`; efs-utils watchdog source |
| A quarantine repository with alternates to the mirror ingests a bundle whose prerequisites are only in the mirror, pushes from there, and a failed ingest leaves the mirror untouched | Run on 2.50.1 (me) |
| A before/after pack cleanup racing a repack deletes the consolidated pack and dangles every head | Reviewer 4b on 2.50.1 (not re-run; the design no longer has the cleanup) |
| `nsenter` does not inherit seccomp, `NoNewPrivileges` or the bounding set | Reviewers 4a and 4b, from kernel and systemd semantics (not run) |
| RLIMIT_CORE is ignored for a piped `core_pattern` | Reviewer 4a: kernel v6.1 `fs/coredump.c` L585–604 |
| `check-ref-format --branch` takes exactly one argument and rejects `--end-of-options` | Reviewer 4a on 2.50.1 |
| `git rev-list --not --stdin` does not negate stdin revisions; `^<tip>` lines do | Run on 2.50.1 (me; reviewer 5b first) |
| Non-recursive `ls-tree -z` gives the root `.github` entry's mode and object ID | Run on 2.50.1 (me) |
| `ls-tree -r` without `-z` C-quotes non-ASCII, tab and `"` names; fsck passes a `.` tree entry by default | Reviewer 5a on 2.50.1 (D10 design input only) |
| The quarantine works for new, rebased, forked-from-old-base, orphan-settings, up-to-date, non-fast-forward and stale-lease pushes, and sends a thin pack | Reviewer 5b on 2.50.1, against a 20 000-commit fixture |
| Every `canopy-inspect` property is accepted as a transient property | Reviewer 5b: v252 `bus-unit-util.c`, `run.c` (read, not run) |
| bash ignores `--rcfile` for a login shell | Reviewer 6a: bash 5.2 `shell.c`, and run on bash 3.2 |
| A leftover `refs/heads/<x>.lock` fails every fetch | Reviewer 6b on 2.50.1 |
| A reader keeps reading a pack that a concurrent `repack -a -d --cruft` unlinked | Reviewer 6b (experiment) and 6a (`packfile.c` L2075, `pack-objects.c` L1569/L1665) |
| `fetch.fsckObjects` alone refuses a `.` tree entry at index-pack; `fetch.fsck.<id>` severities are honoured by bundle fetches | Reviewer 6a on 2.50.1 |
| Duplicate and unsorted tree entries are refused at ingest; `.GitHub` + `.github`, mode tricks and replace refs would be refused by D10's rule | Reviewer 6a on 2.50.1 (the ingest half applies in v9; the rule half is D10 design input) |
| `pack-refs --all` holds per-ref locks and `packed-refs.lock`, and a concurrent fetch fails with "Unable to create '…lock': File exists" | Reviewer 7b on 2.50.1 |
| systemd 252 SIGKILLs the whole cgroup when the main process exits under `KillMode=mixed` | Reviewers 7a, 8a: v252 `service.c` L1998–2000, L2063–2081, `unit.c` L4615 |
| A fetch holds `index-pack --keep=fetch-pack` until its refs update | Reviewer 7a (traced) |
| `bundle create` writes `-<oid> <subject>`, with the subject's raw bytes | Reviewers 8a and 8b on 2.50.1 |
| `rename(2)` of a directory onto a non-empty one fails `ENOTEMPTY` | Reviewer 8b |
| A bad token, a missing repository and no auth all print git's same "could not read Username" line | Reviewer 8b on 2.50.1, against GitHub |
| `for-each-ref --contains` exits 129 on a missing or non-commit object | Reviewer 9b on 2.50.1 |
| `--pipe` passes the caller's stdin, stdout and stderr through | Reviewer 9a: v252 `run.c` L776–781 |
| The App path's `refreshCredential` is a no-op; the 60 s floor is the token path's | Reviewers 9a and 9b: `github-auth.ts` L156, L266–272, L304–317 |
| A `GIT_CONFIG_GLOBAL` file's extraheader is read as global scope, and appears in neither traced argv nor the environment | Run on 2.50.1 (me) |
| `systemd-coredump` journals `COREDUMP_ENVIRON` even when `LimitCORE=0` refuses storage | Reviewer 10a: v252 `coredump.c` L368–376, L796, L915, L1280; kernel v6.1 `fs/coredump.c` L582, L645 (AL2023's `core_pattern` and `ec2-user`'s groups unverified) |
| `cat-file --batch-check` prints `<oid> missing`; several `--contains` mean "any"; an orphan survives `repack --cruft` | Reviewer 10a on 2.50.1 |
| **Needs a real deploy:** EFS I/O from a `PrivateNetwork` unit through efs-utils' proxy; IMDS on EC2 | §5 |

## 11. Decisions (made 2026-10-10, by the manager; D5 by JP)

- **D1 Boundary:** C, the GitHub gateway.
- **D2 Rollout:** Template first, with boot-time selection by the bundle's contract banner. The
  next contract version goes on `WORKER_CONTRACT_REQUIREMENTS` (#485).
- **D3 Self-checks:** fatal.
- **D4 Base and default branch never pushed:** shipped ahead of the split as #490, in
  single-process mode. The gateway keeps the refusal; PR 3 adds `protectedBranches`. Residual for
  PR 3: `delete-remote-branch` guards base and settings, but not GitHub's default branch (GitHub
  refuses that delete itself; not verified live).
- **D5 Exports:** re-export the gateway server, client and local implementation from
  `canopycms/worker/cms-worker`. No new entrypoint (JP approved).
- **D6 Container verification:** done; §10.
- **D7:** the Clerk secret key moves to the gateway too.
- **D8:** a static `canopy-github` system user.
- **D9 CMS branch namespace:** P2,
  [gateway-cms-branch-namespace.md](gateway-cms-branch-namespace.md).
- **D10 Gateway-side `.github` refusal:** P2,
  [gateway-github-config-refusal.md](gateway-github-config-refusal.md); the best design reached
  is recorded there.
- **D11 Root-owned worker log:** shipped ahead of the split as #491. PR 6 builds on it.

Also filed: [worker-dedicated-user.md](worker-dedicated-user.md) (R2) and
[worker-single-process-race-gap.md](worker-single-process-race-gap.md) (R6), plus a note in
[worker-github-mirror-limits.md](worker-github-mirror-limits.md).

## 12. Review rounds

### Round 1 (two independent Fable reviewers, in parallel)

**1a: adversarial security.** Verdict: no path to the credential, Clerk key or instance role
survives *if every directive applies*. The two must-fix items were the token in argv and bundle
intake.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| 1 | HIGH | A `@filter` bundle leaves a `.promisor` pack that poisons the mirror and weakens fsck; a blob head is accepted. | **Accepted, partly reproduced.** §3.3 intake: header parsed in node, capability allowlist, cleanup, partial-clone state treated as corruption, `GIT_NO_LAZY_FETCH`, commit-type check. |
| 2 | HIGH | The token stays in argv; only `ProtectProc` hides it, and nothing checks that. | **Accepted.** §3.4 env-based extraheader (verified); §5 `/proc` self-check. Former R7 removed. |
| 3 | HIGH | "Editor branch" is undefined: any non-base branch can be pushed, force-pushed or deleted, and PRs run adopter CI. | **Accepted in part.** Protected set and `protectedBranches`, PR base/head rule, and an honest R1 and Security Model naming rulesets as load-bearing. A namespace is D9: pre-existing and out of scope. |
| 4 | MED | Workflow pushes rely on GitHub scope. | **Accepted:** the workflow-path refusal in policy. |
| 5 | MED | Plaintext secrets in the worker's `.env` stay honoured. | **Accepted:** a separate `gateway.env`; the worker refuses secret variables in split mode. |
| 6 | MED | Base-branch identity: a mismatch-refusal is a DoS lever, and the default branch is resolved only once. | **Accepted:** warn, don't refuse; the protected set takes env ∪ default (TTL) ∪ list. |
| 7 | MED | PR `base` is attacker-controlled (`branch.json`). | **Accepted, then superseded by round 2 (M3):** head must not be protected; `base` is not restricted. |
| 8 | LOW | `InaccessiblePaths=/mnt/efs` can be shadowed by mount propagation. | **Accepted:** `RequiresMountsFor`, a boot check, and a container test. |
| 9 | LOW | DoS envelope. | **Accepted:** one in-flight push, 1 GiB configurable cap, cleanup on every path, `have` bound. |
| 10 | LOW | `completeLifecycle` is callable at will. | **Accepted:** logged, and listed in R5. |
| — | note | `ProtectHome=tmpfs` covering `/run/user` is load-bearing; IPv6 IMDS is off. | **Accepted:** §5 and §1. |

**1b: feasibility against the code.** Verdict: C is the right boundary, but the transfer and
error surfaces were under-specified.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| H1 | HIGH | `push` cannot express "already up to date" (settings every cycle, re-run tasks, branch equal to base); the marker test is undefined. | **Accepted:** `{ branch, sha, lease }` with an optional body; the `up-to-date` outcome; the returned SHA drives the marker test. |
| H2 | HIGH | Error classification is lost; `createOrUpdatePullRequest` is missing. | **Accepted:** Octokit status, headers and message verbatim; `pr.createOrUpdate`; `workflow-refused` carries the file. |
| H3 | HIGH | Credential-refresh triggers are on the wrong side. | **Accepted:** the gateway self-triggers (GitHub and Clerk); the worker-side calls are deleted. |
| H4 | HIGH | A hand unit stamped 2 without the socket variable silently runs single-process. | **Accepted:** contract 2 requires the variable; split is mandatory at ≥ 2 in the CDK entry; self-checks unconditional. |
| M1 | MED | Refusing on a base mismatch regresses a default-branch change. | **Accepted:** warn only (as 1a-6). |
| M2 | MED | Tracking namespace misnamed. | **Accepted:** `refs/remotes/github/*`. |
| M3 | MED | No push prerequisite fallback; a full fetch per roll. | **Accepted:** the ladder; the cost documented. |
| M4 | MED | Stop ordering and drain between the two units. | **Accepted:** §3.1 ordering, gateway `KillMode`/`TimeoutStopSec`, shutdown mapping. |
| M5 | MED | Gateway startup failures never reach the admin panel; `clerkConfigured`. | **Accepted:** `health` carries both; the worker records them. |
| M6 | MED | "Nothing changes until PR 6" is false. | **Accepted:** §8 says what ships when; review gates moved. |
| M7 | MED | PR 1 is a test-corpus rewrite. | **Accepted:** budgeted as one, at Opus tier. |
| M8 | MED | `fetch` returns the worker's own objects; coalescing across different `have`s is wrong. | **Accepted:** `have` includes `refs/heads/*`; only the GitHub fetch is coalesced. |
| L1–L8 | LOW | No fsck on unbundle; streaming; framing; poll bounds; `completeLifecycle`; gateway stamp; PR 1 interface; repo rules. | **All accepted:** the worker trusts the gateway; fetch pipes straight in; two requests; ≤ 60 s polls; logged; stamp added; final interface in PR 1; D5, `lint:bundle`. |

### Round 2 (two fresh, independent Fable reviewers, in parallel)

**2a: adversarial security on v2.** Verdict: no new path to the secrets; three spec-tightening
MEDIUMs. The reviewer's first draft raised a CRITICAL, then withdrew it, citing
`ProtectSystem=strict`. **I reinstate it on my own reading of systemd 252's source**:
`setup_output` runs, as root, before the mount namespace exists.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| (withdrawn) | **CRITICAL (mine)** | The worker owns its log directory. systemd opens the `append:` log as root, following symlinks, before any sandbox applies. A worker that won the race can redirect it into `/etc/ld.so.preload` and become root. | **Accepted:** §3.1 rule (root-owned log directories, no `LogsDirectory=`), §5 table, PR 6 audit and container test, R8. |
| F1 | MED | The push-identity invariant is unstated, and node's and git's header parsers disagree. | **Accepted:** §3.2 states it in three clauses, with a test; the intake checks that the staging ref equals `sha`. |
| F2 | MED | The workflow refusal is spelling-sensitive (case, symlink, renames); with a classic PAT it is the only line. | **Accepted:** §3.2 check rewritten (case-insensitive, symlink and gitlink, `--find-renames`, new commits only); docs recommend a scoped credential. |
| F3 | MED | `redactCredentials` misses the extraheader forms, and `git config -l` dumps them. | **Accepted:** scrub every form; config dumps banned; canary over every form. |
| F4 | MED | A compromised worker can forge the alarm's heartbeat. | **Noted, not fixable here:** R5 says the alarm detects faults, not compromise. Not worse than today. |
| F5 | LOW | `gateway.env` creation mode and order. | **Accepted:** `install -m 0640` after `useradd`. |
| F6 | LOW | Banner trust is deploy authority. | **Accepted:** a sentence in §7. |
| F7, F8 | INFO | Socket impersonation is safe by design; the Clerk direction is correct. | Container test for `/run/canopy-github` ownership kept. |

**2b: feasibility on v2.** Verdict: the design holds; one HIGH and six MEDIUMs, each with a
local fix.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| H1 | HIGH | One `update-ref` transaction freezes the namespace on a D/F rename. | **Accepted, reproduced:** two transactions, deletes first, with a per-ref fallback. |
| M1 | MED | The empty-bundle case also covers ancestor (non-fast-forward) pushes. | **Accepted:** JSON-only push first; `need-objects`; an empty bundle means no body. |
| M2 | MED | The merge-base workflow check is undefined for the orphan settings branch. | **Accepted:** new-commits check via `rev-list --not`. |
| M3 | MED | "PR base must be protected" breaks submits after a base change. | **Accepted:** the rule is dropped, and the reason recorded (the base does not bound what runs). |
| M4 | MED | An inline refresh can blow the 60 s task deadline. | **Accepted:** respond first, refresh detached. |
| M5 | MED | PR 1's fakes drop the real classification coverage. | **Accepted:** a `remoteUrl` option; the named suites keep the real gateway. |
| M6 | MED | The hashbang is line 1, and an existing banner shim is there. | **Accepted:** match within the first 5 lines; generated from `WORKER_CONTRACT_VERSION`; build test. |
| L1–L8 | LOW | Body-less push with a missing `sha`; unbounded re-read loop; socket `Requires`; coalesce invalidation; the env glob covering ARNs; `response.data`; glob docs; triple-streaming. | **All accepted:** `need-objects`; ≤ 3 re-reads; `Requires`/`Sockets` and client timeouts; push invalidates the coalesce; ARNs move to `gateway.env`, by intent; `data` forwarded; docs; `need-objects` replaces the ladder. |

### Round 3 (two fresh, independent Fable reviewers, in parallel)

**3a: adversarial security on v3.** It swept the whole root-opens-a-worker-controlled-path class
and found no survivor. Verdict: no CRITICAL or HIGH; two MEDIUMs.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| F1 | MED | The bundle head's refname reached `git fetch`'s argv: option injection planted `remote.*.promisor` config that step 5 did not detect. It also contradicted the "refname not used" clause. | **Accepted:** the head line must be byte-equal; the refspec is a fixed literal; `--end-of-options` on every gateway git; the config-key scan; a test. |
| F2 | MED | The R9 inspection recipe was an incomplete sandbox. Hostile config could run as unsandboxed `ec2-user`, then `~/.bashrc`, then `NOPASSWD` sudo, then root. Root writes into `/mnt/efs` follow symlinks. | **Accepted:** a checked-in `canopy-inspect` sandbox, the "never touch EFS as root" rule, and refusal messages reworded, all in PRs 6 and 7, not a future task. |
| F3 | LOW | Coredumps. | **Accepted:** `LimitCORE=0` on both units; `core_pattern` in the audit. |
| F4 | LOW | The workflow check's new-commit set; CPU burn. | **Accepted:** `--not --branches`, after a joined fetch, with a 5 000-commit cap. |
| F5 | LOW | `push` workflows are not named. | **Accepted:** R1 and the Security Model name them, plus `permissions:`. |
| F6 a–g | LOW | Bundle id lookup, the `have` filter, PEM/JWT scrub, log newline escape, `EAFNOSUPPORT` pass, `gateway.env` write, ref-name normalisation. | **All accepted.** (a) and (b) go into PR 2's spec: the id is an in-memory map key, and `have` is filtered to commits. The rest are in §3.2 and §5. |

**3b: feasibility on v3.** Verdict: the boundary, rollout, log rule and stop ordering hold. Two
HIGHs and three MEDIUMs in the object negotiation.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| H1 | HIGH | Bundle prerequisites are boundary commits, so the subset rule refused ordinary not-yet-rebased submits. | **Accepted, reproduced:** each prerequisite must be a commit reachable from a mirror head; the subset rule is gone; a test. |
| H2 | HIGH | A failed ingest leaves an unpushable commit, and "`sha` in mirror" never asks for objects again, so the branch wedges. | **Accepted:** the no-body test is reachability; new packs are deleted after a failed ingest; a test. |
| M1 | MED | The workflow exclusion set was wrong, with false positives on a fresh or never-fetched mirror. | **Accepted** (as 3a-F4). |
| M2 | MED | A detached refresh breaks the 5/10/20 s retry ladder. | **Accepted:** start detached; every credentialed op joins it. |
| M3 | MED | The first fetch under a 300 s client cap, with abort killing git, livelocks a large repository. | **Accepted:** fetch is a detached job polled with an inactivity bound. |
| L1 | LOW | The re-read loop; restart semantics. | **Accepted:** a re-read restarts from `readPublishedSha`. A hand-built bundle (`pack-objects`) was weighed and rejected as more bespoke code. |
| L2 | LOW | Stale text: the PR 1 interface, and a `CacheDirectory` with no user. | **Fixed:** `CacheDirectory` dropped. (Corrected in v6: worker → gateway streams; GitHub → worker is staged in the gateway's state directory, see "The cost".) |
| L3 | LOW | The banner needs a node build script. | **Accepted:** in PR 6, `build:worker` moves to the esbuild API. |
| L4 | LOW | The legacy `push-and-create-pr` needs `pr.create`. | **Accepted:** added. |

### Round 4 (two fresh, independent Fable reviewers, in parallel)

**4a: adversarial security on v4.** Verdict: no CRITICAL or HIGH; no path to any asset; two
MEDIUMs.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| F1 | MED | The `canopy-inspect` entry by `machinectl`/`nsenter` is not a sandbox: an entered `ec2-user` has no NNP, so sudo works, then root. That re-opened round 3's chain. | **Accepted:** a wrapper around `systemd-run --pty -p …` generated from the same constant, in-shell assertions, and an explicit "never nsenter". |
| F2 | MED | The Security Model overclaimed: the gateway stops authoring workflow content, not selecting historical workflows. | **Accepted:** R1 and the Security Model reworded, with mitigations named; the tighter subtree rule is offered under D9 (since v8, D10). |
| F3 | LOW | Per-parent `diff-tree` refuses legitimate merges. | **Accepted:** set equality with at least one parent. |
| F4 | LOW | `check-ref-format --branch` breaks with `--end-of-options`; node-side validation; bidi in logs. | **Accepted.** |
| F5 | LOW | The fetch job has no gateway-side bound. | **Accepted** (also 4b-3). |
| F6 | LOW | `LimitCORE` wording. | **Accepted.** |
| F7 | LOW | `pr.*` act on any PR number. | **Accepted:** listed in R1. |
| F8 | LOW | The PEM scrub misses escaped forms. | **Accepted:** per-line scrub. |
| F9 | LOW | The outgoing-bundle disk. | **Accepted:** one pending bundle per client, serialized. |

**4b: feasibility on v4.** Verdict: one HIGH and four MEDIUMs, each with a local fix.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| 1 | HIGH | The pack cleanup after a failed ingest raced a repack and wrecked the mirror (reproduced). | **Accepted, design change:** the quarantine repository (verified). The mirror is written only by GitHub fetches and maintenance, all under `exclusive`. Dangling heads added to the corruption check. |
| 2 | MED | Mirror maintenance has no owner. | **Accepted:** the gateway self-schedules it under `exclusive`, with `commit-graph`. |
| 3 | MED | The fetch job is unbounded, and an unknown job id was unspecified. | **Accepted.** |
| 4 | MED | Push-op ordering; `usable` defined two ways; an outage gives false permanent refusals. | **Accepted:** joined fetch first, `transient` on failure, `usable` = reachable. |
| 5 | MED | `canopy-inspect` is not enterable safely. | **Accepted** (as 4a-F1). |
| 6 | LOW | Stale text: abort scope; the socket sentence was inverted. | **Fixed.** |
| 7 | LOW | `LimitCORE` wording. | **Fixed.** |
| 8 | LOW | Roll handover cost. | **Accepted:** the gateway pre-fetches at boot. |
| 9 | LOW | PR table gaps; coalescing. | **Accepted:** refresh triggers deleted in PR 1, maintenance in PR 2, coalescing timed from completion. |
| 10 | LOW | The `build:worker` script. | Noted; feasible beside 106's metadata script. |

### Round 5 (two fresh, independent Fable reviewers, in parallel)

**5a: adversarial security on v5.** Verdict: no path to any asset. But the workflow rule was
bypassable (one HIGH, one MEDIUM), and the Security Model text overclaimed.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| F1 | HIGH | `ls-tree -r` C-quotes non-ASCII, tab and `"` names, so they escape the prefix test. | **Accepted, design change:** the rule now compares the root `.github` entry's object ID. No paths are parsed. |
| F2 | MED | A `.` tree entry passes fsck and defeats the prefix test. | **Accepted:** the same rule change, plus `fetch.fsck.hasDot` etc. as errors. |
| F3 | MED | The Security Model overclaimed: the Lambda's reach, the op list, "alters". | **Accepted:** reworded. |
| F4 | LOW | The quarantine's `alternateRefsCommand` pin walks the whole repository. | **Accepted** (also 5b). |
| F5 | LOW | The inspect directives differ from the worker's; a path; the rcfile. | **Accepted:** one constant, absolute path, root-owned `--rcfile`. |
| F6 | LOW | Retained mirror objects are exfiltrable by object ID. | **Accepted:** listed in R1. |
| F7 | LOW | Some odd names pass validation. | Noted: the protected-set comparison is on the exact string. |

**5b: feasibility on v5.** Verdict: the design holds and the quarantine works for every push
shape tried. One HIGH and four MEDIUMs.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| HIGH | HIGH | `--not --stdin` does not negate stdin, so a > 5 000-commit repository refuses every push. | **Accepted, reproduced:** `^<tip>` stdin lines; a test on a fixture above the cap. |
| M1 | MED | The quarantine must not carry `core.alternateRefsCommand=true`. | **Accepted.** |
| M2 | MED | `exclusive` is non-reentrant, so step 7 would self-deadlock. | **Accepted:** one session for steps 3–7, plain calls inside. |
| M3 | MED | Repack under `exclusive` stalls pushes. | **Accepted:** maintenance runs beside sessions, as today (it is safe now that no pack cleanup exists). |
| M4 | MED | The cost of `ls-tree -r` per commit. | **Accepted:** O(1) root-entry compare. |
| L | LOW | Stale text (the inspect unit name, the spy exemption, `fetch/:id`, job reuse wording, "both directions stream", round-1 #7); crash sweep; inactivity from spawn; a vanished prerequisite. | **All fixed.** |

### Round 6 (two fresh, independent Fable reviewers, in parallel)

**6a: adversarial security on v6.** Verdict: no path to any asset. The `.github` rule held
against duplicates, ordering, case, mode, odd bytes, stale heads, replace refs and
quarantine-only parents. One MEDIUM.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| F1 | MED | `bash -l` ignores `--rcfile`, so the inspect assertions never run. | **Accepted:** `bash --rcfile … -i`; a negative container case. |
| F2 | LOW | The pty relays hostile bytes to the operator's terminal. | **Accepted:** a docs line; `--pipe … \| cat -v`. |
| F3 | LOW | The root-commit rule was ambiguous. | **Fixed:** compared against the empty set. |
| F4 | LOW | `GIT_NO_REPLACE_OBJECTS`. | **Accepted.** |
| F5 | LOW | GitHub-side semantics (folding, symlinked workflows, `uses: ./`). | Noted: inside R1; unverified against GitHub. |
| INFO | — | Item 4 is already the default at index-pack; `=error` pins kept. | Noted. |

**6b: feasibility on v6.** Verdict: one HIGH and two MEDIUMs.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| HIGH-1 | HIGH | A rebased CMS branch carrying a developer's direct `.github` edit is refused for ever, and even a revert is refused. | **Accepted:** rule 3's second clause (equal to some mirror head's set); tests for the accepted shapes; R1 notes the cost. |
| M2 | MED | The crash sweep misses ref locks and `.keep` files, so every push is `transient` until a roll. | **Accepted:** extended sweep, at start and on a "cannot lock ref" failure. |
| M3 | MED | Maintenance vs `exclusive` was stated three ways, and the rebuild must hold `exclusive`. | **Accepted:** one statement, with the session's real reasons; rebuild and sweep under `exclusive`; PR 2 row fixed. |
| L4–L9 | LOW | Root-commit wording, classifications, policy cost, a `contentRoot` under `.github`, PR-table gaps, stale text. | **All fixed:** `bundle-rejected` → `transient`; a per-tree cache and `cat-file --batch`; config validation in PR 3; drain mapping, `health` fields, sweep, pre-fetch and rebuild assigned to PRs; the `refs/canopy` text corrected. |

### Round 7 (two fresh, independent Fable reviewers, in parallel)

**7a: adversarial security on v7.** Verdict: no path to any asset; the `.github` claim holds
within R1, apart from "parking". One MEDIUM.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| F1 | MED | The inspect assertions do not observe the network cut, and the negative test is vacuous. | **Accepted:** the rcfile runs the worker's self-checks plus `/sys/class/net`; one negative case per assertion. |
| F2 | LOW | Rule 3's head-tip clause lets the attacker park a `.github` set. | Moot in v8 (rule deferred); recorded under D10's known costs. |
| F3 | LOW | Cache and coprocess lifetime. | Moot in v8; D10 says per-push. |
| F4 | LOW | The on-failure sweep is not safe beside maintenance. | **Accepted** (as 7b-M1). |
| F5 | LOW | Gateway-side refusals must not arm the refresh. | **Accepted.** |
| F6 | LOW | Stale R5 line; rebuild in place. | **Accepted:** line deleted; staging rebuild with rename. |
| F7 | INFO | `StateDirectory` defaults to `0755`. | **Accepted:** `StateDirectoryMode=0700`. |

**7b: feasibility on v7.** Verdict: three MEDIUMs.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| M1 | MED | The on-failure sweep can unlink locks that live maintenance holds, and that maintenance probably caused the trigger. | **Accepted:** a maintenance mutex taken by the sweep and the rebuild; trigger text corrected; repack and commit-graph temp names added to the start-up sweep. |
| M2 | MED | The `.github` rule still wedges a legitimate rebase (a developer `.github` edit plus a base `.github` change). | **Resolved by removal:** v2–v7's rule leaves this plan; the one-level-down design is recorded as D10. |
| M3 | MED | The Security Model overclaims after the head-tip clause. | **Resolved by removal:** the text no longer claims a `.github` refusal and names the credential's scope as the control. |
| L1–L5 | LOW | Two implementations named; `contentRoot: '.'`; gateway stop vs the fetch job; PR-table gaps; stale text. | **Fixed or moot:** the stop pinned (SIGTERM kills the fetch job); the PR table repaired; stale text fixed; `contentRoot` validation is moot without the rule. |

**Why the `.github` rule left the plan.** It was added in v2 in answer to round 1's "workflow
pushes rely on GitHub scope". Every round since found a bypass (case, renames, quoting, a `.`
entry) or a legitimate shape it wedges. It is not the credential gap this task closes, and today
a scoped credential stops the same thing at GitHub. D10 keeps the best design for a decision of
its own.

### Round 8 (two fresh, independent Fable reviewers, in parallel; the intended closing round)

**8a: adversarial security on v8, whole plan.** Verdict: **no MEDIUM or above.** No path to the
GitHub credential, the Clerk key, the instance role, root or `canopy-github`.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| F1 | LOW | The refresh-arming claim is stronger than its mechanism; the floors are the real bound. | **Accepted** (merged with 8b-F1): the arming rule is redefined and the floors stated as the bound. |
| F2 | LOW | Prerequisite-line format; an unbounded header line. | **Accepted:** the grammar, and a 64 KiB header bound. |
| F3 | LOW | `/dev/shm` is shared and writable. | **Accepted:** `InaccessiblePaths=/dev/shm` on both units and in the inspect constant. |
| F4 | LOW | Sweep lock order; maintenance sequence unnamed; bundle creation's hold. | **Accepted** (with 8b-F2). |
| F5 | LOW | The pty caveat is incomplete (OSC 52). | **Accepted:** `--pipe | cat -v` by default, `--interactive` opt-in with a warning. |
| F6 | LOW | Doc consistency (`DynamicUser` text, the citation, push-loop fetch rate). | **Fixed.** |

**8b: feasibility on v8, whole plan.** Verdict: three MEDIUMs, all spec pins, none touching the
boundary.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| F1 | MED | The narrowed refresh trigger drops today's recovery cases (lost access, the plain exit 128), and §3.1 contradicted it. | **Accepted:** today's ungated rule minus gateway-local refusals; §3.1 fixed. |
| F2 | MED | The sweep waited on the mutex while holding `exclusive`, stalling pushes for a repack; the rebuild's lock order was unstated. | **Accepted:** try-acquire and skip; one order (`exclusive` then mutex); maintenance takes only the mutex; `pack-refs` last. |
| F3 | MED | The prerequisite-line rule could be implemented to refuse every real bundle. | **Accepted:** an explicit grammar and a test. |
| F4 | LOW | The rebuild cannot be one rename. | **Accepted:** aside, swap, remove; the sweep covers leftovers. |
| F5 | LOW | Stale text. | **Fixed:** §10 rows marked as D10 input; D9 → D10; the fsck pins are now in intake step 3; `DynamicUser` reason. |
| F6 | LOW | PR-table gaps. | **Fixed:** each element assigned (`StateDirectoryMode` and `/dev/shm` in PR 6; the base warning and arming in PR 1; log escaping in PR 3; `GIT_NO_*` spy in PR 2; the `/mnt/efs` check in PR 6; `concurrency.md` in PR 7). |
| F7 | LOW | Non-commit `sha` classification. | **Accepted:** `refused-by-policy`, checked before reachability. |

### Round 9 (two fresh, independent Fable reviewers, in parallel)

Both found the same defect, which I had introduced in v9's text: in the inspect recipe, the
operator's shell parsed `&&`, so the command after it would have run as root, unsandboxed, on
EFS. That is the R9 chain itself.

**9a: adversarial security.** Verdict: no path to any asset; one MEDIUM (the `&&`).
**9b: feasibility.** Verdict: one HIGH (the same `&&`); the rest LOW.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| 9a-M, 9b-H1 | HIGH | `inspect-checks && <command>` runs `<command>` outside the sandbox. | **Fixed:** `inspect-checks` is an exec wrapper (`exec "$@"`); nothing shell-composed outside the sandbox; positive container checks (`id -u` = 1000, NNP/seccomp shown) that would catch an escape. |
| 9a-L | LOW | `--pipe` passes stdin and stderr through. | **Fixed:** `</dev/null 2>&1 \| cat -v`. |
| 9a-L, 9b-L2 | LOW | Floors misstated (there is no App mint floor). | **Fixed:** token path vs App path stated from source; any new App re-mint must add a floor. |
| 9a-L | LOW | The refresh join is a push-stall lever. | **Accepted:** in R5. |
| 9a-L, 9b-L4b | LOW | The on-failure sweep's scope. | **Fixed:** locks and temporaries only, then one retry; an inactivity-killed job cleans its own `tmp_pack`/`.keep`. |
| 9a-L | LOW | LF-only vs a prerequisite comment ending in `\r`. | **Fixed:** LF-only applies to the other line kinds; the comment is opaque. |
| 9a-INFO | — | `/dev/shm` masking is source-verified only; the Security Model's "only". | **Fixed:** container check added; "among CanopyCMS's processes". |
| 9b-L1 | LOW | An absent `sha` is an error, not an empty list. | **Fixed:** a three-way branch on `cat-file -t`. |
| 9b-L3 | LOW | Clerk re-snapshot gate. | **Fixed:** any Clerk error arms the re-read; only 401/403 re-snapshots. |
| 9b-L4a, L4c | LOW | `maintain()`'s `ensure()` would deadlock the rebuild; cadence unstated. | **Fixed:** maintenance never takes `exclusive`; cadence and timeouts pinned; a test. |
| 9b-L5 | LOW | A crash between the rebuild renames. | **Fixed:** restore `.old` when `github.git` is absent. |
| 9b-L6 | LOW | PR-table gaps. | **Fixed:** self-checks and gateway SIGTERM in PR 5; fetch-job details in PR 4; the base warning in PR 3. |
| 9b-L7 | LOW | Citation mismatch; a second `need-objects` loop. | **Fixed.** |

### Round 10 (two fresh, independent Fable reviewers; fixes reviewed as hard as the design)

**10a: adversarial security.** Verdict: one MEDIUM. A crash primitive on hostile bytes (R3)
plus `systemd-coredump` journaling the environment plus a worker that can read the journal
equals the credential. It rests on three platform facts not verified locally. Everything else
LOW.
**10b: feasibility.** Verdict: one MEDIUM (a nested-`exclusive` rebuild wedges the gateway);
the rest LOW.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| 10a-F1 | MED | `COREDUMP_ENVIRON` journals an environment-borne credential despite `LimitCORE=0`, and `ec2-user`'s groups read the journal. | **Accepted, mechanism changed:** the credential goes in a per-command `GIT_CONFIG_GLOBAL` file, given only to GitHub-bound git (verified), never in `process.env`; journal directories hidden; `core_pattern=core` + `suid_dumpable=0`; a SEGV-with-canary container check. |
| 10b-M | MED | A rebuild triggered from `create()` as a nested `exclusive` wedges every session. | **Accepted:** the rebuild runs inline in the detecting session; a test. |
| 10a-F2 | LOW | Crash recovery restored the corrupt `.old`. | **Fixed:** complete the swap from `.rebuild`. |
| 10a-F3 | LOW | Lock-text failures arm the refresh; per-prerequisite walks; `cat-file -t` keying; maintenance inside the session. | **Fixed:** lock text is local; one `rev-list` walk; `--batch-check`; detached maintenance. |
| 10a-F4, 10b-L | LOW | Inspect pins: `exec --`, `pipefail`, `--quiet`, cwd, the self-check source, `/run/user` and `/dev/shm` unobserved. | **Fixed:** all pinned; negative cases added. |
| 10a-F5 | LOW | R1's cruft-window text was wrong. | **Fixed.** |
| 10b-L | LOW | Size-warning cadence; Clerk gate "as today" was not; a joiner's bundle outside the session; PR-table gaps. | **Fixed:** size check after every job; Clerk gate reverted to today's 401/403; a joiner gets its own session; 3-restart, second `need-objects` and rebuild tests in PR 2; PR 6 cites §9. |

### Round 11 (two fresh, independent Fable reviewers), then the container run

**11a: adversarial security.** Verdict: no path to any asset; the §3.4 credential file holds
(argv and environment clean). One MEDIUM, a verification gap rather than an exploit.
**11b: feasibility.** Verdict: no new path; three MEDIUM spec pins.

| # | Sev | Finding | Response |
| - | --- | ------- | -------- |
| 11a-F1 | MED | `core_pattern`/`suid_dumpable` are host-global, so the container check is vacuous; a `sysctl.d` file alone applies only at the next boot. | **Accepted:** `sysctl --system` after writing; a gateway boot self-check that fails closed; moved to first-deploy. |
| 11b-M1 | MED | simple-git blocks `GIT_CONFIG_GLOBAL` without `allowUnsafeConfigPaths`. | **Accepted:** the opt-in only on the GitHub-bound instance; a test that the block stays elsewhere. |
| 11b-M2 | MED | The prerequisite walk does not enforce "is a commit", and `rev-list --stdin` honours pseudo-options. | **Accepted:** `cat-file --batch-check` first; 40-hex validation named as load-bearing. |
| 11b-M3 | MED | Silent maintenance commands die under an inactivity timeout. | **Accepted:** a wall-clock bound for maintenance; it cleans its own temporaries. |
| 11a-F2 | LOW | The credential is in the heap of every child of a GitHub-bound command. | **Accepted:** stated as an R3 residual; `GIT_TRACE2*` banned. |
| 11a-F3 | LOW | `core_pattern=core` leaves core files from other daemons. | **Accepted:** `DefaultLimitCORE=0` drop-in. |
| 11a-F4, 11b-L1 | LOW | `PrivateTmp` is not necessarily tmpfs, and in dev mode it is shared `os.tmpdir()`. | **Accepted:** the file lives in `StateDirectory` via `mkdtemp`. |
| 11a-F5 | LOW | Lock-text matching. | **Accepted:** own lines only, never `remote:`. |
| 11b-L2 | LOW | `GIT_CONFIG_GLOBAL` displaces dev global config; the key's origin. | **Accepted:** documented; origin from `remoteUrl`. |
| 11b-L3 | LOW | `-` on each `InaccessiblePaths` entry. | **Accepted**, and used in the container run. |
| 11b-L4 | LOW | sysctl ordering and consequences. | **Accepted** (with 11a-F1/F3). |
| 11b-L5 | LOW | Fetch job ids. | **Accepted:** per request. |
| 11b-L6 | LOW | Rebuild failure backoff. | **Accepted:** 5 minutes. |

**The container run** (§10 rows) confirmed the network cut layer by layer, `/proc` hiding,
socket permissions, `@system-service`, the gateway's lack of EFS, and the `canopy-inspect`
wrapper. It **reproduced round 2's CRITICAL against today's layout** and showed the plan's
layout blocks it. It also corrected two self-checks:
- `/sys/class/net` shows the host's interfaces inside `PrivateNetwork`, so the check reads
  `/proc/self/net/dev` instead;
- a `/run/user` check is vacuous with nobody logged in, so the check reads `/home` instead.

**Stopping here.** The manager's rule was to stop when a round finds nothing at MEDIUM or above.
Round 11 did not quite meet it: all four of its MEDIUMs are specification pins or a
verification gap, each now folded in, and none is a path to an asset. On 2026-10-10 I told JP I would stop after round 11 unless it found a real new path; it found
none. **The manager decides** whether to accept the stop or to ask for a round 12. My
recommendation is to accept it: the remaining review is the `/review-rounds` on each
implementation PR.
