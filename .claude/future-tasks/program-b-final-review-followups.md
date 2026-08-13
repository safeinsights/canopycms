# Workstream B final-review findings not fixed in the epic

Found by the adversarial review of the full `epic/canopy-hardening` diff
(2026-07-30), after all nine PRs had merged. The CRITICAL and the two
false-positive HIGHs were fixed on `docs/program-b-bookkeeping` before the epic
PR opened; these are the remainder, ranked as the reviewer ranked them.

Related: [resolved/program-b-canopy-hardening.md](resolved/program-b-canopy-hardening.md).

---

## HIGH — the non-fast-forward diagnosis names the wrong cause, and its advice would orphan a PR

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
[occ-version-key-contentid-swap.md](occ-version-key-contentid-swap.md).

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

## MEDIUM — the worker bypasses `resolveDeploymentName`

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

---

## MEDIUM — one bad ref halts the whole sync cycle, every cycle

`worker/cms-worker.ts`'s `reconcileTrackedBranches` wraps both `update-ref`
calls but **not** the `rev-list` between them. A single `refs/heads/<x>` pointing
at a missing or partially-written object — plausible on EFS with a concurrent
Lambda writer — throws out of the loop, out of `syncGit`'s try, and skips
`pushSettingsBranches`, `refreshBaseBranchWorkspace` and `rebaseActiveBranches`.
Nothing self-heals, so it recurs every cycle.

**Fix direction:** per-branch try/catch → log → `continue`, matching the two
`update-ref` calls.

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

- Malformed `rev-list` output makes `parseInt` yield `NaN`, which falls through
  to `diverged` and is then warned to operators as a genuine cross-deployment
  collision (`cms-worker.ts`). Noise only.
- ~~`deploy-cms.yml.template` runs `npm ci` (this repo mandates pnpm, and it
  fails with no `package-lock.json`) and hardcodes `branches: [main]`, so an
  adopter with a different default branch gets silence rather than an error.~~
  (RESOLVED 2026-08-12, `fix/deploy-template-cdk-app`.) The install and build
  commands are now written for the detected package manager in **both**
  `deploy-cms.yml.template` and `Dockerfile.cms.template` — fixing only the
  workflow would have moved the same failure into `cdk deploy`'s image build.
  The trigger branch comes from `origin/HEAD`, falling back to `main`.
