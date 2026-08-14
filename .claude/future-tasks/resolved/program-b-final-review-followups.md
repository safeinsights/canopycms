# Workstream B final-review findings not fixed in the epic

Found by the adversarial review of the full `epic/canopy-hardening` diff
(2026-07-30), after all nine PRs had merged. The CRITICAL and the two
false-positive HIGHs were fixed on `docs/program-b-bookkeeping` before the epic
PR opened; these are the remainder, ranked as the reviewer ranked them.

Related: [resolved/program-b-canopy-hardening.md](program-b-canopy-hardening.md).

---

## ~~HIGH — the non-fast-forward diagnosis names the wrong cause, and its advice would orphan a PR~~ (RESOLVED 2026-08-12)

`api/branch-status.ts` (409) and `worker/cms-worker.ts` (`PermanentTaskError`)
both attribute a rejected push to "another CanopyCMS deployment sharing this
repository, or a direct push to GitHub", and tell the user to **rename the
branch**.

The likeliest cause is neither. `rebaseActiveBranches` rewrites the history of
every `editing`/`locked` branch that is behind base (`cms-worker.ts`), and
**nothing pushes the rebased history back into `remote.git`** — there is no
`forcePush` caller anywhere. So after any base-branch advance the clone diverges
from `remote.git`'s ref and the next editor submit is non-fast-forward.

On the worker side it is worse: `branch-review.ts` puts a changes-requested
branch back to `editing`, re-enrolling a branch that has a **live PR** into the
rebase loop. The next `push-and-update-pr` is then non-fast-forward, now raises
`PermanentTaskError` (skipping the retry budget the pre-epic code had), and
writes that text into `syncFailureReason` — which this epic newly surfaces in
the editor UI. Renaming the branch at that point would orphan the open PR.

The underlying wedge is pre-existing; what the epic added is a confident, wrong,
user-visible diagnosis and the loss of the retries.

**Fix direction:** state the observable fact (the branch diverged from the
remote and needs reconciliation) without attributing a cause; distinguish the
local-origin push in `branch-status.ts`, where the worker's own rebase is by far
the likeliest explanation, from the GitHub push in `cms-worker.ts`, where a
foreign deployment is at least plausible. Better still, have the rebase loop
push the rebased branch into `remote.git` so the divergence never arises.

**RESOLVED** (2026-08-12, `fix/worker-sync-divergence`) — fixed by the "better
still" route, both hops together, plus both messages.

One correction to the finding: today the FIRST observable failure is the 409,
not the worker's `PermanentTaskError`. `submitBranch` pushes clone→`remote.git`
before any task is queued, so that push is the one rejected; the worker-side
message needs `remote.git` to diverge from GitHub, which nothing currently
causes — and which publishing into `remote.git` **alone** would have armed.
That is why both hops had to move together.

The rebase loop now publishes what it rewrites: `historyRewrittenFrom` records
the commit the rebase replaced, `remote.git` is force-pushed under
`--force-with-lease=<branch>:<that commit>`, and the GitHub hop is queued and
uses the same lease. Ordering is marker → push → queue, so every crash window
leaves the marker set with the work unfinished, which a new self-heal pass
completes on a later cycle without waiting for another base-branch advance.

The arming guard is the load-bearing part, and an adversarial review of the
first draft of this plan is what produced it: the loop force-publishes **only
when `remote.git` holds exactly the commit the clone is rebasing away**. Branch
clones never fetch their own branch while `reconcileTrackedBranches`
fast-forwards `remote.git` to GitHub's tip, so after a reviewer pushes a fixup
straight to the PR branch, `remote.git` legitimately holds a commit the clone
has never seen. Leasing on "whatever remote.git holds" would have been
satisfied there and would have silently deleted that fixup from `remote.git`
and then from GitHub. `cms-worker-rebase-publish.test.ts` pins that case first.

Two things surfaced only by testing against real git, both now covered:
`isNonFastForwardRejection` does not match a refused lease (git prints
`(stale info)` and none of the strings it looks for), so `isStaleLeaseRejection`
was added beside it; and git refuses a stale lease **even for an ordinary
fast-forward**, so a marker left behind by a failed clear would have wedged
every later push on that branch. The GitHub push therefore falls back to a
PLAIN push on a refused lease — git accepts that only if it fast-forwards, so
it can never destroy anything — and only a rejection of THAT is permanent.

The retry budget stays as-is (`PermanentTaskError`), deliberately: an identical
push still cannot succeed, and the reconciliation is the leased push itself,
attempted on the first try.

**A boundary this fix depended on, found after the PR opened** (while answering
"what are you least sure of"): branch workspace directories are provisioned
under `sanitizeBranchName(...)` (`paths/branch.ts`), but task payloads carry the
raw git ref name, and `cms-worker.ts` joined the RAW name onto
`contentBranchesPath` in three places. They differ for any name outside
`[A-Za-z0-9._-]` — `feature/x` lives in `feature-x`. Pre-existing, and until now
merely cosmetic (`updateBranchMetadata`/`updateBranchMetadataOnFailure` quietly
dropped their write after a failed `fs.stat`), but this change made correctness
depend on it: the history-rewrite marker read as absent, the push went out
unleased, and a slash-named branch wedged exactly as before the fix. All three
sites now go through one `branchWorkspacePath()` helper. Reproduced with a
red-first test before fixing.

Related and NOT changed: the rebase loop writes the *sanitized* directory name
into metadata's `name` field while the API writes the raw ref name. Harmless
today (`name` is not used for path resolution) but a genuine inconsistency —
worth a separate look rather than a drive-by in this PR.

> **Now tracked on its own** (2026-08-13):
> [branch-metadata-name-sanitized-vs-raw.md](../branch-metadata-name-sanitized-vs-raw.md).
> It sat here inside a struck finding, where open work is invisible. That file
> also corrects this paragraph: the raw-ref writer is the admin metadata
> **repair** path, not the API handlers (those write back whatever metadata
> already held, which is the sanitized name).

---

## ~~HIGH — finalize's decode validation only checks frame 0 of animated GIF/WebP~~ (RESOLVED 2026-08-12)

`assets/pipeline.ts` calls sharp without `animated`/`pages`, so it decodes page
0 only, while `assets/transform.ts` — the decoder its own comment says it
mirrors — decodes all frames up to 60. The reviewer reproduced this: corrupting
real 5-frame animated GIFs at six byte offsets inside frames 2–5 left the
finalize check **passing** while the transform call threw
`gifload_buffer: Invalid frame data`. The asset is accepted at upload and 422s
on first transform — precisely the state the feature exists to prevent.

**Fix direction:** probe the page count and pass
`{ pages: Math.min(totalPages, MAX_ANIMATED_FRAMES) }`; export the frame cap so
both call sites stay in step.

**RESOLVED** (2026-08-12, `fix/asset-decoder-mismatch`) — fixed as directed, and
the finding reproduced first: a 5-frame GIF corrupted at 8 offsets inside the
later frames showed 3/8 accepted by finalize but rejected by transform with
`gifload_buffer: Invalid frame data`; after the fix, 0/8 (the two halves now
return the same verdict at every offset).

`MAX_ANIMATED_FRAMES` moved from module-private in `transform.ts` to an export
in `transform-directives.ts`, which is where `MAX_INPUT_PIXELS` already lives
for the same reason — and it had to be that module, not `transform.ts`:
`transform.ts` imports sharp *statically*, while `pipeline.ts` imports it
*dynamically inside a try/catch* so finalize still works when the native binary
is missing. Importing the constant from `transform.ts` would have dragged a
static sharp import into `pipeline.ts` and defeated that fail-open path.
`transform-directives.ts` is dependency-free by design, so both sides now read
one number and agree by construction — including on which frames past the cap
they both ignore.

`rasterIsDecodable` now probes metadata for the page count, then decodes
`min(totalPages, MAX_ANIMATED_FRAMES)`. The probe is required rather than
incidental: sharp's `pages` is a fixed request, not an upper bound, so
overshooting throws "bad page number". Fail-open/fail-closed semantics are
unchanged (load failure = open, byte rejection = closed 422); a probe throw
counts as a byte rejection, matching what `applyTransform` does with the same
bytes.

Regression tests in `pipeline.test.ts` use a **self-validating** fixture: the
corrupt-animated-GIF test also asserts `applyTransform` rejects the same bytes,
so it can never pass vacuously if a future encoder change makes the fixture
decodable again. Verified the test fails without the fix. Two over-rejection
guards accompany it (a valid animated GIF, and a valid 65-frame animation that
must be capped rather than rejected).

---

## ~~HIGH — branch switch back to a previously-visited branch renders the other branch's entries~~ (RESOLVED 2026-08-12)

`editor/hooks/useEntryManager.ts`. Pre-SWR, `setEntriesInitializing(true)` fired
unconditionally on every branch-change effect. It is now gated on SWR's
`isLoading`, which is `false` whenever any cached data exists. On A → B → A, SWR
returns A's cache with `isLoading: false`; the `refreshSeqRef` guard correctly
refuses to commit the stale payload, but nothing resets the
`entriesState`/`collectionsState` mirrors — so **branch B's entries stay
rendered, unflagged, while `branchName` reads A**.

Clicking one then calls `loadEntry`/`saveEntry` with A plus B's contentId. If a
same-path entry exists on both branches, the OCC version lookup (keyed
`${branch}:${contentId}`) misses and **conflict detection is silently skipped on
save**. That is the part that makes this more than cosmetic.

The existing branch-switch race test uses two first-time-visit branches, so it
never exercises the cached path.

**Fix direction:** derive entries/collections from SWR `data` directly, as
`useCommentSystem` already does, or reset the mirrors in the same effect that
clears `selectedPath`. Add a test that visits A, B, then A again.

**RESOLVED** (2026-08-12, `fix/branch-switch-stale-entries`) — but the trigger
above is **not** the one that was still live, and the correction matters for
anyone reading this finding later.

The A→B→A *cached-replay* half described here had already been fixed before this
work started, by the per-branch committed-seq rule (see `refreshSeqRef`'s doc
comment), and it *is* covered: `useEntryManager.test.ts`'s "switching A→B→A
inside the SWR dedupe window…" test. The claim that no test exercises the cached
path was stale.

What remained open was the complement, and it was broader than a race: the commit
effect's `if (!taggedEntries) return` fires whenever the new branch has **no
cached data yet** — every first visit to a branch — so the previous branch's
entries stayed committed for the entire duration of the new branch's fetch.
Reproduced: on `branch-b`, the rendered entry's `apiPath` still read
`/api/canopycms/branch-a/...`, and the selection-fallback effect **auto-selected**
it with no click from the user. `entriesInitializing` was true but bought
nothing — `Editor.tsx` only consults it when `!currentEntry`, and
`EntryNavigator`'s loader only replaces an *empty* tree. The OCC consequence
reproduced exactly as described (`expectedVersion: undefined`, so
`content-store.ts` skips the mtime check and the save blind-overwrites).

Fixed by neither listed direction but by a third: the three mirrors
(`entries`/`collections`/`availableSchemas`) collapsed into one `BranchView`
record **stamped with the branch that produced it**, with the rendered values
derived from it and falling back to empty when the stamp doesn't match. That
makes cross-branch bleed unrenderable by construction rather than dependent on
an effect having run, and covers both early returns plus the render-before-effect
window. A full derive-from-SWR was rejected as disproportionate: `refreshEntries`
commits synchronously and the per-branch claimed/committed machinery orders those
commits, so reworking it risked reintroducing the races that machinery just fixed.

Consuming SWR's `error` was **required**, not incidental: `shouldRetryOnError` is
false, so without it a single failed load would leave the stamp permanently
unmatched and the pane stuck at "Loading content…" forever. That path now settles
to the empty state and reports (notification + `console.error`), restoring
surfacing the SWR migration had dropped.

Three regression tests, each verified red before green — the stale render, the
OCC consequence, and the failed-load path. The OCC test had to reproduce the
*interleaving* (open an entry → the new branch's data lands → save) because a
load and save back-to-back give the contentId no chance to change in between and
pass against the unfixed hook.

One related hazard is deliberately **not** closed here: the version map is keyed
by contentId, so any other path that swaps an entry object's contentId between
load and save still yields a version-less write. Tracked in
[occ-version-key-contentid-swap.md](../occ-version-key-contentid-swap.md).

### Three corrections to PR #196's own description

Recorded here because #196 is merged and its body can no longer be the accurate
version.

**The navigator-spinner claim was too broad.** The PR said the navigator spinner
will *not* appear during a switch, because `Editor.tsx`'s
`collectionsFromApi.length > 0 ? collectionsFromApi : collections` falls back to
the prop collections and keeps the tree non-empty. That holds only for adopters
who **pass** a `collections` prop — which the first-party path does. For an
adopter who passes none, the derived list going empty now leaves `treeData`
empty too, and the spinner **does** show during the switch window. So the
behaviour is inconsistent between the two adopter shapes; making it consistent
is [entry-navigator-loader-empty-tree.md](../entry-navigator-loader-empty-tree.md).

**The fix closed a write hazard that was never separately filed.** Before #196,
`handleCreateEntry` resolved through `collectionByPath`, which was built from the
stale mirrors — so during a branch switch it could resolve a collection belonging
to the **previous** branch and then create an entry at that path on the
**current** branch, via `options.branchName`. Post-fix the derived map is empty
during that window, so the handler's existing `if (!col) return` guard makes the
create a no-op instead. This was found while chasing consumers of
`activeCollections` after the fact, not while fixing; there is no regression test
aimed at it specifically. **Anyone tempted to restore the old "fall back to the
last known collections" behaviour would reopen it.**

**One boundary was considered but is untested.** A long-lived modal mounted
*across* a branch switch — `PermissionManager` (`collections={activeCollections}`)
and `CollectionEditor` (`availableSchemas={availableSchemas}`) — now sees its
list briefly empty out mid-switch where it previously saw the previous branch's
data. Judged benign because both render lists rather than writing through them,
and because the write paths that do consume these (`handleCreateEntry`, the
reorder handler at `Editor.tsx:694`) are guarded by not-found early returns and
are unreachable with entries empty. No test covers a modal open across a switch;
this was a reasoned call, not an oversight.

**Correction (2026-08-13): the reorder handler's guard was NOT actually
unreachable.** Found by the 2026-08-12 adversarial review of the editor's
write-lock surface; fixed in the PR that added this correction. The claim above
conflated the two write paths -- `handleCreateEntry`'s half is accurate,
`handleReorderEntry`'s is not. `handleReorderEntry` never reads `entriesState`
at all: it resolves its target collection with
`findCollection(activeCollections, collectionPath)`, and `activeCollections`
(`collectionsFromApi.length > 0 ? collectionsFromApi : collections`) is exactly
what stays NON-empty during a switch for any adopter who passes a `collections`
prop -- the first-party shape this whole section is about, and the same
fallback the navigator-spinner correction above already flagged. So the
guard's `if (!collection) return` never fired: the handler resolved the OLD
branch's collection out of the stale build-time props and sent ITS `order`
array as a write to the NEW branch. Fixed by resolving against
`collectionsFromApi` directly instead of `activeCollections`, so "not yet
loaded for this branch" and "loaded, has no such collection" are now the same
(correct) not-found outcome -- plus a user-visible notification, since a
silent no-op on a clicked menu item reads as a broken button. See
`Editor.integration.test.tsx`'s `'reorder mid-branch-switch'` tests for the
regression coverage this section noted was missing.

---

## ~~HIGH — the deploy template has no CDK app to deploy against~~ (RESOLVED 2026-08-12)

`cli/template-files/deploy-cms.yml.template` runs `npx cdk deploy --all` from
the repo root with no `--app`, which requires a `cdk.json`. `initDeployAws()`
writes only `Dockerfile.cms`, `.dockerignore` and the workflow, and
`docs/deploying-to-aws.md` never mentions `cdk.json`, `cdk init`, or
`bin/app.ts`. An adopter following the scripted path gets a CI run that fails on
the first deploy step.

**Resolved** on `fix/deploy-template-cdk-app`. `init-deploy aws` now scaffolds
`cdk.json`, `infrastructure/bin/app.ts` and `infrastructure/lib/cms-stack.ts`.
The `cdk init` alternative was rejected: it refuses to run in a non-empty
directory, so it cannot be scripted into an existing app.

Two further first-run failures were found while fixing this and fixed with it:
the workflow passed none of the environment variables the stack needs (so the
deploy would still have failed at synth), and nothing ensured the
`tsx`/`aws-cdk-lib`/`constructs`/`canopycms-cdk` devDependencies the app entry
point imports. The workflow also now deploys **by stack name** rather than
`--all`, which would have deployed an existing-CDK adopter's unrelated stacks on
every content merge.

Verified by `packages/canopycms-cdk/src/scaffold-synth.test.ts`, which scaffolds
with the real CLI and then synthesizes through the generated `cdk.json`.

---

## ~~MEDIUM — the worker bypasses `resolveDeploymentName`~~ (RESOLVED 2026-08-12)

`canopycms-cdk/worker/index.ts` reads `process.env.CANOPYCMS_DEPLOYMENT_NAME ??
'prod'` directly: it never consults `config.deploymentName` and never runs the
validation, while the documented precedence is env > config > mode default.

For a prod deployment where the env var is not stamped (a non-CDK adopter, a
hand-rolled systemd unit, docker-compose) but `config.deploymentName: 'staging'`
is set, the Lambda owns `canopycms-settings-staging` while the worker owns
`canopycms-settings-prod`. `pushSettingsBranches` then reports the real branch as
"foreign" and returns without pushing — **settings changes silently never reach
GitHub, behind one warn line.**

**Fix direction:** resolve through `resolveDeploymentName` in the worker too, or
fail loudly when the owned settings branch is absent while a differently-named
`canopycms-settings-*` branch is present.

**RESOLVED** (2026-08-12, `fix/worker-sync-divergence`) — both, because the
first alone does **not** fix this finding's own scenario. The worker cannot
read the adopter's `canopycms.config.ts`, so routing through the resolver
cannot recover a `config.deploymentName` the worker was never given; what it
does fix is precedence and validation, and it belonged in `CmsWorker`'s
constructor (`config.deploymentName ?? 'prod'`) rather than only in the CDK
entrypoint — the entry's `?? 'prod'` was just the outer half of the same
mistake. That `?? 'prod'` is now gone; the resolver reads the env var itself.

The scenario is caught by the second route, with a sharper signature than the
one suggested here: a foreign `canopycms-settings-*` head **with no
corresponding GitHub tracking ref**. Only this deployment's own API can push
into `remote.git`, so such a branch was written locally and never reached
GitHub. "Owned absent + foreign present" alone would have fired on the
*supported* two-deployments-one-repo case, where the foreign branch arrives via
the GitHub fetch and this deployment simply has not had a settings edit yet —
a warning every 5 minutes, wrongly.

Note for adopters: env now beats a `deploymentName` passed programmatically to
`CmsWorker`, matching the Lambda. An invalid stamped value now throws ~~at
construction (a loud startup exit)~~ instead of producing a broken branch name.

**Correction (2026-08-13, `fix/worker-startup-surfacing`).** "A loud startup
exit" was wrong, and the 2026-08-12 adversarial review of
`integration-202607-a` caught it. `lastFatalError` is written only by
`start()`'s catch, and the AWS entrypoint constructs `CmsWorker`
(`canopycms-cdk/worker/index.ts:85`) before calling `start()` (`:119`) — so a
constructor throw landed outside every status-writing path. With systemd
`Type=simple` + `Restart=always` and cfn-signal deliberately absent, the real
behaviour was an INVISIBLE ~5s crash-loop: `cdk deploy` reported success and
the admin panel showed the worker as `'absent'` with no fatal error. Resolution
now happens in `ensureSettingsBranch()`, called first inside `start()`'s try,
so the same throw is recorded to `worker-status.json` and reaches the admin
panel. The claim above is struck rather than deleted so the mis-attribution
stays visible.

---

## ~~MEDIUM — one bad ref halts the whole sync cycle, every cycle~~ (RESOLVED 2026-08-12)

`worker/cms-worker.ts`'s `reconcileTrackedBranches` wraps both `update-ref`
calls but **not** the `rev-list` between them. A single `refs/heads/<x>` pointing
at a missing or partially-written object — plausible on EFS with a concurrent
Lambda writer — throws out of the loop, out of `syncGit`'s try, and skips
`pushSettingsBranches`, `refreshBaseBranchWorkspace` and `rebaseActiveBranches`.
Nothing self-heals, so it recurs every cycle.

**Fix direction:** per-branch try/catch → log → `continue`, matching the two
`update-ref` calls.

**RESOLVED** (2026-08-12, `fix/worker-sync-divergence`) — fixed as directed,
with the `NaN` LOW below folded in: a malformed `rev-list` count is now treated
as an unreadable branch (log + `continue`) instead of falling through to
`diverged`.

The regression test needed three attempts to become real, and the working
fixture is not the obvious one. A ref pointing at a wholly **absent** object
kills the cycle-opening fetch, before the reconcile is ever reached; an ancestor
object that is merely **deleted** gets silently re-sent by that same fetch and
heals itself. Only a **zero-length (torn) ancestor object** survives the fetch
and reaches `rev-list` — which is also the likelier EFS failure. It must also
land on a workspace already in its steady state, since a fetch only walks a
branch's history when it has something new to transfer.

---

## ~~MEDIUM — `SWRProvider` omits the cache isolation the project's own test helper mandates~~ (RESOLVED 2026-08-12)

`editor/context/SWRProvider.tsx` sets no `provider`, so it uses SWR's
module-global cache — while `editor/hooks/__test__/test-utils.tsx` passes
`provider: () => new Map()` with a comment warning that omitting it causes key
collisions. Keys carry the branch but no instance identity, so two concurrently
mounted editors on different backends but the same branch name would share
entries. No live trigger today (single-editor model), and SSR does not leak.

**Fix direction:** `provider: () => new Map()`.

**RESOLVED** (2026-08-12, `fix/branch-switch-stale-entries`) — fixed as directed,
folded in alongside the branch-switch fix above since it is the same subsystem.
`SWRProvider` is mounted once (`CanopyEditor.tsx`), so the cache now spans the
editor session while being isolated from any `SWRConfig` the host app runs for
its own data. The one behavioral consequence is noted in `refreshSeqRef`'s doc
comment: its remount reasoning ("SWR's cache … survives") now means remounts
*below* `CanopyEditor` — remounting `CanopyEditor` itself starts a fresh cache,
which is the same code path as a first load.

---

## LOW

- ~~Malformed `rev-list` output makes `parseInt` yield `NaN`, which falls through
  to `diverged` and is then warned to operators as a genuine cross-deployment
  collision (`cms-worker.ts`). Noise only.~~ **RESOLVED 2026-08-12**
  (`fix/worker-sync-divergence`) — folded into the sync-cycle guard above.
  Covered structurally rather than by a test: reaching it needs `rev-list` to
  exit 0 with unparseable output, which no fixture produces without mocking.
- ~~`GitManager.forcePush` uses a bare `--force-with-lease` with no expected
  value. Branch clones are `--single-branch` and never fetch their own branch,
  so they carry no remote-tracking ref for it and git would refuse with
  "stale info" — the method cannot work as written for any caller. It has none
  today (noted while fixing the HIGH above, which deliberately did not route
  through it). Either give it an explicit expected-SHA parameter or delete it,
  before someone calls it believing it works.~~ **RESOLVED 2026-08-13** (PR #172
  human review, finding 6) — deleted rather than given an expected-SHA
  parameter. Confirmed zero production callers (only its own SEC-H2 test) and
  that `GitManager` is not re-exported from any package entrypoint, so removal
  is not a breaking change. The removed test only re-checked the
  `--end-of-options` option-injection guard already covered by `push()`'s
  identical test; no unique coverage was lost. The real
  `--force-with-lease=<branch>:<sha>` mechanism used in production
  (`worker/cms-worker.ts`'s rebase-publish path) is untouched and keeps its own
  test coverage.
- ~~`deploy-cms.yml.template` runs `npm ci` (this repo mandates pnpm, and it
  fails with no `package-lock.json`) and hardcodes `branches: [main]`, so an
  adopter with a different default branch gets silence rather than an error.~~
  (RESOLVED 2026-08-12, `fix/deploy-template-cdk-app`.) The install and build
  commands are now written for the detected package manager in **both**
  `deploy-cms.yml.template` and `Dockerfile.cms.template` — fixing only the
  workflow would have moved the same failure into `cdk deploy`'s image build.
  The trigger branch comes from `origin/HEAD`, falling back to `main`.
