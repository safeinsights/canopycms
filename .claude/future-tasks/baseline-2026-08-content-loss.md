# Baseline review 2026-08: four ways the product destroys work it said it saved

Found by the August 2026 whole-codebase baseline review (5 independent Fable reviews at
`integration-202607-a` @ `6770327c`, findings verified first-hand by the lead reviewer).
Full traces: [REVIEW-REPORT-2026-08.md](../../REVIEW-REPORT-2026-08.md) findings 1, 2, 5, 6, 8.

These four are grouped because they are **one failure mode, not four bugs**: an operation
reports success and the user's content is then silently lost or reverted. None is caught by the
test suite. Fix in this order — the first two are small and independent, the third needs a
design decision.

**Merge-conflict note:** like `program-b-final-review-followups.md`, findings here are struck
~~in place~~ as they resolve rather than moved, because the file holds several. When a conflict
pairs two versions, the question is whether each *individual* finding is struck.

---

## 1. [P0] "Create entry" with an existing slug silently wipes that entry

`editor/components/EntryCreateModal.tsx:93-108`'s `validateSlug` checks format only — never
collision, though the collection's entries are already loaded client-side. The payload is
`{format, data:{}, body:''}` with no `expectedVersion`. Server-side `api/content.ts:328`
computes `exists` but uses it only for the `maxItems` guard and for `isCreateScaffold` (`:348`,
which requires `!exists`) — **never to refuse a create against an existing document**. So the
empty payload is validated as an ordinary update; with no required fields that passes, and
`store.write` runs at `:447` with `expectedVersion: undefined`, so OCC is skipped. Data becomes
`{}`, body `''`, and the client shows a green "Created new entry".

Save writes the working tree and only Publish commits, so the destroyed content was never in
git — **no recovery, not even `git checkout`**.

**Fix direction:** server-side create-intent (or `expectedVersion: null` = "must not exist")
that 409s when `exists`. The rename path already has this guard — `api/content.test.ts:372`
tests "returns 400 when slug already exists" — so copy it. Add the client pre-check too, purely
for a message that names the real problem.

**Guard to add:** create over an existing slug returns 409 and leaves content byte-identical.

---

## ~~2. [P0] The worker's rebase deletes editor saves that were already acknowledged~~

**RESOLVED (August 2026, [SYNC-C1]).** Fixed with a real cross-host lock rather than the
marker sketched below: a marker is check-then-act, so a write can pass the check and still
land mid-rebase. `utils/content-write-lock.ts` (proper-lockfile, anchored on
`{branchRoot}/.canopy-meta`) is now taken by `ContentStore.write`/`delete`/`renameEntry`
and, asymmetrically, by the rebase loop — the worker acquires with zero retries and skips
the branch (reported as `skippedLocked`) because it retries every cycle, while writers wait
briefly and then 409 with `BranchSyncingError`. Reads deliberately do not take it. The
misleading comment is corrected, `docs/concurrency.md` documents the layer, the asymmetry
and the stale-takeover caveat, and `worker/cms-worker-content-lock.test.ts` carries the
regression (verified red against the pre-fix code first). Remaining gap tracked separately:
schema and asset mutations are not under this lock — see
[content-write-lock-coverage-gaps.md](content-write-lock-coverage-gaps.md).

`worker/cms-worker.ts:2166-2171` skips dirty branches, then rebases. The comment at `:2162-2165`
claims the residual TOCTOU is safe ("the rebase will fail and the catch block will abort
safely") — true only for a save landing *before* `git rebase` starts. After it starts (a window
spanning fetch, replay and N conflict rounds of awaited git subprocesses on EFS), a save is
destroyed either by `rebase --abort` (`:2315`, `:2332`) hard-resetting the tree, or by
`checkout --theirs` (`:2292`) overwriting the just-saved file — after which **the rebase
succeeds and nothing logs a failure**.

Not a narrow race: Lambda's `ContentStore.write()` and the worker's rebase touch the same
working tree on shared EFS, and content files have only an **in-process** mutex.
`docs/concurrency.md`'s "who uses what" table lists no cross-process write exclusion for content
files, and its residual-windows list does not name this.

**Fix direction:** real exclusion. Preferred: a `.canopy-meta/rebase-in-progress` marker (reusing
`resource-generation.ts`) that the content write boundary turns into a 409 — degrades to a retry
rather than a stall. Alternative: a shared advisory lock the worker holds for the rebase.
**Correct the `:2162-2165` comment as part of the fix** — it is why this survived review.

**Guard to add:** inject a content write after conflict round 1 and assert the file survives
whatever the loop does. The existing `cms-worker-rebase.test.ts` provides the harness; today all
its cases use a quiescent tree.

---

## 3. [P1] A branch switch during a slow load writes old-branch content into the new branch

`editor/Editor.tsx`: the skip gate (`:441`), the in-flight dedup (`:447`) and the state writes
(`:452-456`) are all keyed by **bare `contentId`** with no branch qualifier, and none of the
writes checks whether the branch changed during the fetch. (`currentContentIdRef` exists but its
own comment scopes it to clearing the loading flag and suppressing a toast.)

So after a switch, the old branch's pending `loadEntry` resolves and writes old content under the
key the new branch also uses. Then `loadedValues[contentId]` is defined, so the gate **suppresses
the fresh load** — the editor shows old-branch content as the new branch's — and because OCC
tokens are branch-keyed, the lookup misses, `expectedVersion` is omitted, and the save is a
**blind cross-branch overwrite**.

Precondition is mild: the same `contentId` on both branches is normal (branches are clones, IDs
are embedded in filenames).

**Fix direction:** branch-qualify the keys, or re-check the branch after `await loadEntry` before
writing state.

**Guard to add:** switch branches mid-load; assert the new branch's content loads and the
subsequent save carries `expectedVersion`.

---

## 4. [P1] Opening an entry manufactures a persisted draft that can revert a colleague's work

`Editor.tsx:453-456` seeds `drafts[contentId] = loaded` on every load — a **pristine** draft with
zero edits — and `useDraftManager.ts:229-238` persists every drafts change to localStorage. The
dirty rule (`:144`) counts a restored draft with no `loadedValues` entry as dirty, and
`loadedValues` starts empty on mount. Browsing five entries yields "5 files modified" next
session and false unsaved-changes prompts on branch switch.

The data-loss half: the restored draft is a full stale snapshot, `effectiveValue` prefers it over
the fresh load, and Save sends the **fresh** load's OCC token — so it passes conflict detection
and reverts intervening work with a green "Saved".

This partially regresses a bug already fixed here: the comment at `useDraftManager.ts:305-313`
explains that dropping the draft key after save exists precisely to kill "the 'phantom dirty'
bug". That fix covered the save path; the open path still seeds one.

**Related, same PR:** `handleReload` (`useDraftManager.ts:443-467`) has no dirty check and no
confirm, and at `:448-449` overwrites both `loadedValues` and `drafts` — while
`handleDiscardFileDraft` three lines above (`:428-441`) does confirm. Reload is **the advertised
409 recovery**: the conflict toast tells the losing editor to reload, which destroys the work
they were about to lose. Also persist the draft's base version (today drafts restore with no base
version and save against a freshly captured token, so cross-session conflicts are undetectable
by construction).

**Fix direction:** stop seeding drafts on load — `effectiveValue = draft ?? loadedValue` renders
fine from `loadedValues` alone. Add the dirty-check + confirm to `handleReload`, matching its
sibling. Persist the draft's base version so a stale restore raises the conflict UX.

**Guard to add:** open-without-editing leaves zero drafts after reload; reload with a dirty draft
prompts before discarding.
