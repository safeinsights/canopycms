# [P2] PR #229 human-review follow-ups (deferred items)

From the human review of [PR #229](https://github.com/safeinsights/canopycms/pull/229#pullrequestreview-4938780868)
(`integration-202608-a` → `main`, **approved** with two fix-first findings), 2026-08-14.

The two fix-first findings (#1 `NumberField` sign loss, #2 settings-workspace 503 taking
down `/admin`) and the small fold-ins (#3 `GitRemoteRefMissingError` over-classification,
#4 message advertising an unreachable action, #5a lock-message wording, #6 permanently
unsaveable legacy draft, #10, #11, #12, #13, #14, #15) were all fixed on the branch. What
follows is what was **not** fixed, with the reviewer's own reasoning preserved.

The reviewer's process note is worth keeping: the two most consequential findings were both
in code the composed-diff review's coverage statement did not claim — the new field
renderers, and the blast radius of a newly added fail-loud path. "The areas that got
adversarial attention are clean, and the defects moved to what the review's coverage
statement didn't claim."

---

## 1. Browser/server `mode` mismatch is undetectable at runtime (review finding #7)

`packages/canopycms/src/cli/template-files/Dockerfile.cms.template` declares
`ARG NEXT_PUBLIC_CANOPY_MODE=dev`, so an image built **without** the build arg produces a
dev-mode editor bundle against a prod server — it sends dev-auth headers at a server
enforcing Clerk (every editor call rejected) and hides the pull-request UI.
`operating-mode/mode-env.ts`'s stated principle is that a wrong mode must fail loudly
("a typo here would silently deploy dev auth semantics"), and the default does the opposite
by construction.

The generated CDK stack passes `prod`, so `canopycms init-deploy aws` is fine. The exposure
is the hand-built image — which `docs/deploying-to-aws.md` explicitly anticipates, i.e.
exactly the case a runtime check would earn its keep.

**Fix direction:** the server knows both halves at request time (`CANOPY_MODE` on the
server; the client bundle's belief is observable from what the editor sends). Either a
one-time warning, or a `mode` field on `/user` that the editor asserts against its own
inlined value, converts a silent misconfiguration into a diagnosable one.

**Secondary, same file:** `readModeEnv` selects the variable by
`typeof window !== 'undefined'`, so one component's SSR pass and its client pass can resolve
different modes whenever only one variable is set. The reviewer could not construct a real
divergence in the documented deployment (both are `prod`, and the editor page is dynamic),
but the invariant "both variables must agree" is currently unwritten and unchecked.

## 2. `branchHealth` scans every branch's whole content tree inside a 60s Lambda (review finding #8)

`packages/canopycms/src/branch-health.ts:113-132, 216` — `scanDuplicateContentIds` builds a
full `ContentIdIndex` per healthy branch, unconditionally, on every admin health request.
That is N branches × a full recursive `readdir` over EFS in one request, on a function whose
default timeout is 60s: a deployment with a few dozen live branches and a real content tree
is where the admin panel stops loading precisely when someone is trying to diagnose
something.

`catch { return [] }` also reports "no duplicates" for a scan that failed or timed out
mid-way — the wrong direction for a health check.

**Fix direction:** put it behind a query flag (`?duplicates=1`) or a separate endpoint, or
bound it (first N branches + a `truncated` marker); the existing `q=`-style opt-in precedent
in this API fits. Distinguish "none found" from "not determined" in the response either way.

**Coupling to watch:** the admin panel now renders `duplicateContentIds` read-only (added in
the PR #229 follow-up work — see item 4 below), so gating the scan means the panel has to
pass the flag.

## 3. Settings-workspace init uses the patient provisioning lock on a per-request path (review finding #9)

`packages/canopycms/src/settings-workspace.ts:204-207, 244`. Two things compound:

- `acquireProvisioningLock` is the 600-retry / minutes-long variant. Its sibling's docstring
  says why that is the wrong one here: an admin request must fail fast on contention (409
  immediately) rather than hang for that long. This lock is now on the path of **every** API
  request, so a cold-start burst has each container waiting on it until its own Lambda
  timeout.
- `settingsInitLock = null` in the `finally` discards the in-memory memo on **success**, so
  every subsequent request re-runs `assertSettingsWorkspaceIdentity` (a `git status`
  subprocess), `mkdir -p`, a proper-lockfile acquire+release round-trip on EFS, and the
  idempotent `initializeWorkspace` check. Predates this PR; this PR roughly doubles how
  often that path is entered.

Choosing patient-wait over the old race-into-`rm -rf` is unambiguously right. The open
questions are whether a `tryAcquire`-plus-short-budget variant (as `content-write-lock.ts`
does) fits better now that this is a request-path lock, and whether a successful ensure can
be memoized per container.

## 4. Admin UI to *repair* duplicate content IDs (review finding #4, diagnosis half done)

The 409 an editor sees no longer names an action they cannot reach, and the admin panel now
shows a read-only `duplicate IDs` badge per branch — see
[duplicate-content-id-repair-ui.md](duplicate-content-id-repair-ui.md). The action itself is
still unreachable from any UI.

## 5. Two `REVIEW-REPORT*.md` siblings at the repo root (review finding #18)

`REVIEW-REPORT-2026-08.md` now sits beside `REVIEW-REPORT.md`. Committing the review is good
practice; two undated-by-filename siblings at the root will not age well. `docs/reviews/`
(e.g. `docs/reviews/2026-07.md`, `2026-08.md`) keeps the root legible. Deferred here rather
than folded in because the July report is already on `main` and moving it belongs in its own
change, not one buried in a review-fix batch.

## 6. No action taken, recorded so they are not re-raised as findings

- **Review finding #16** — `decodeCollectionPath` is a pure passthrough with an unreachable
  `{ ok: false }` arm (`api/schema.ts:349`). Deliberate and documented ("kept as a named
  function ... so a future re-validation need has one place to add it back"); the reviewer
  agreed it is a reasonable call and noted it only so it isn't later mistaken for a live
  check.
- **Review finding #5b** — the content lock's per-branch granularity (it replaced per-entry
  in-process serialization). The reviewer's verdict: "Not a blocker; the trade is the right
  one." The `DEFAULT_CONTENT_WRITE_LOCK_WAIT_MS` doc now states it is also the
  writer-vs-writer budget; making it config-plumbed is tracked in
  [content-write-lock-tuning-and-granularity.md](content-write-lock-tuning-and-granularity.md).
- **Review finding #17** — new adopter-facing API surface (`Editor.customRenderers`, a
  second positional argument on `CanopyEditorPage`, and `CustomFieldRenderers` /
  `CustomFieldRenderProps` exports from `client.ts`) is backwards-compatible but was not in
  the PR body's table, and `AGENTS.md` asks for approval before widening adopter touchpoints.
  **Needs JP's call**, not an engineering fix: keep as-is, or revert the widening.
