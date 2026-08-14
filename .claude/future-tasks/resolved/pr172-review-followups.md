# PR #172 human review — the nine findings and what happens to each

[PR #172](https://github.com/safeinsights/canopycms/pull/172) (`integration-202607-a` → `main`,
383 files) was **approved with follow-ups** by a human reviewer. The verdict was that nothing
blocked the merge, and that the defects had migrated to the _periphery_ — the CDK construct's
prop surface, the two publish workflows, and one admin recovery handler — while the areas that
had received adversarial review were clean.

Triaged 2026-08-13 against `integration-202608-a` HEAD, after the first eight PRs of the
August baseline-review epic had landed. **All nine findings were re-checked and were still live at triage time**; none had been
incidentally fixed by that epic.

**Status update (2026-08-13, after the epic executed):** seven of the nine are now FIXED and are
struck below — 1, 2, 3 (PR #224), 4 (PR #223, with a follow-up correcting the npm pin), 6 and 9
(PR #227), and 7 (PR #226). The two that remain are the two deferred **by decision**, not by
oversight: #5 (risk acceptance on the `int` publish channel) and #8 (`setBusy` ref-count). Line numbers below are the reviewer's, at
`bfe76e1`.

The three inline comments on the PR are a separate matter: all three are the same CodeQL alert
("workflow does not contain permissions") on `ci.yml`. Worth noting the repo's
`default_workflow_permissions` is already `read`, so the practical exposure is much lower than
the alert implies — real hardening, low urgency, and it needs care because some jobs may
genuinely need write.

Findings are struck ~~in place~~ as they resolve.

---

## Group A — CDK deployment config (#1, #2, #3)

Landing as **one PR together with the baseline review's own A1** (nothing scaffolds or documents
how a deployed Lambda reaches `mode: 'prod'`, see
[baseline-2026-08-production-and-followups.md](baseline-2026-08-production-and-followups.md)).
They are the same subsystem — `canopycms-cdk/src/constructs/cms-service.ts` and
`operating-mode/deployment-name.ts` — and fixing them separately means two passes over the same
files.

### ~~1. [MEDIUM] `environment.CANOPYCMS_DEPLOYMENT_NAME` bypasses the synth guard and desynchronizes Lambda from worker~~

**RESOLVED (PR #224) — the override is validated *and* mirrored into the worker's `.env`, so the two halves cannot resolve different settings branches. Dropping the hatch was rejected as breaking for adopters already using it.**

`cms-service.ts:367` and `:501`. The construct validates `props.deploymentName` at synth, but the
Lambda's environment spreads `...props.environment` **after** `CANOPYCMS_DEPLOYMENT_NAME`, and the
worker's `.env` line reads `props.deploymentName ?? 'prod'` and knows nothing about the override.

Two consequences: the override is **unvalidated**, so `{ CANOPYCMS_DEPLOYMENT_NAME: 'bad name' }`
synths and deploys cleanly and then crash-loops the Lambda at boot — precisely what the synth
guard exists to prevent; and it applies to **one half of the deployment**, putting the Lambda on
`canopycms-settings-<override>` and the worker on `canopycms-settings-<props.deploymentName>`.

The reviewer's sharpest observation: that is exactly the condition `pushSettingsBranches`'s
`[SYNC-M3]` warning was added in the same PR to detect. **The construct ships a documented way to
manufacture the failure the worker now warns about.**

Fix: validate `props.environment?.CANOPYCMS_DEPLOYMENT_NAME` too, and either mirror the effective
value into `envLines` or drop the escape hatch — `props.deploymentName` already covers the
legitimate use. Note `cms-deploy.test.ts:784` asserts the override wins, so it is deliberate; the
two halves disagreeing is what looks unintended.

### ~~2. [LOW–MEDIUM] The heredoc-injection rationale is applied to one of four interpolated values~~

**RESOLVED (PR #224) — `envLines` became name/value pairs mapped through a shared `assertEnvSafe`, so it guards by construction and a future value is covered whether or not anyone remembers. Reproduced first: a newline in `githubOwner` injected an env line, and an `ENVEOF` in `baseBranch` landed `rm -rf /` in user-data.**

`cms-service.ts:495-512`. `envLines` interpolates `githubOwner`, `githubRepo`, `baseBranch` and
`deploymentName`; only the last is validated, though the guard's own comment gives a reason that
applies verbatim to the other three — a newline injects an arbitrary line into the worker's
environment, and a value containing `ENVEOF` terminates the heredoc early. The quoted delimiter
blocks shell expansion and the values are adopter-supplied, so this is robustness rather than a
security hole; the problem is that the guard **reads as more general than it is**.

Fix: one shared `assertEnvSafe(name, value)` over every value reaching `envLines`.

### ~~3. [LOW] `isValidDeploymentName` is duplicated across packages with no drift check~~

**RESOLVED (PR #224) — a shared fixture asserted in both suites (a real import would give the published construct a runtime dependency on `canopycms` it deliberately lacks). Drift is now a red test rather than a comment.**

`cms-service.ts:37` and `operating-mode/deployment-name.ts:46` — byte-identical today, each tested
separately against an overlapping-by-coincidence invalid list, with a "keep the two in step"
comment as the only enforcement. The failure mode is asymmetric in the bad direction: a rule
tightened at runtime but **not** at synth means a value that synths and then crash-loops.

Fix: a shared fixture array of valid/invalid names asserted in both suites, making drift a red
test rather than a comment.

---

## Group B — publish-workflow supply chain (#4)

### ~~4. [MEDIUM] Both publish workflows bootstrap npm from an unverified tarball inside the publishing job~~

**RESOLVED (PR #223) — the bootstrap is **deleted**, not hardened; `pnpm dlx` does non-bypassable SRI verification. Proven by a fake registry serving genuine metadata with a corrupted tarball (`ERR_PNPM_TARBALL_INTEGRITY`, exit 1) against a genuine control. **Follow-up:** the composed-diff review caught that the exact pin `npm@11.4.1` sits below the **11.5.0 OIDC trusted-publishing floor** and would have failed every publish; now pinned to 11.19.0, what the previous floating `npm@11` actually resolved to.**

`.github/workflows/publish.yml:54` and `publish-prerelease.yml:60` `curl` a pinned npm tarball,
extract it, and execute it — **inside the job that holds `id-token: write`** and publishes five
packages with provenance attestation. The version is pinned; the **contents are not verified**.
Anything substituting that tarball executes arbitrary code in the release job, and the resulting
artifacts carry a valid provenance signature. Pinning by version is not integrity.

Also: `install -g npm@11` re-resolves the floating major, so **the npm that actually publishes is
not the pinned `11.4.1`**.

Rated the most security-significant item across both the human review and the August baseline
review. Fix: verify the sha512 from registry metadata before extracting (or use `corepack`, which
verifies integrity, or `pnpm dlx npm@11.4.1`), and pin the second install too.

---

## Group C — small independent fixes (#6, #7, #9)

### ~~6. [LOW] Delete `GitManager.forcePush` rather than leaving it filed~~

**RESOLVED (PR #227) — deleted after verifying no production callers and no re-export from any entrypoint or the `exports` map, so not a breaking change. This closed the last open finding in `program-b-final-review-followups.md`, which moved to `resolved/`.**

`git-manager.ts:1369` (reviewer cited `:1281`). Verified no production callers — only tests, and
#198 deliberately routed around it. Leaving a method named `forcePush` on the public `GitManager`
API, documented as "safer", whose `--force-with-lease` is **inert in exactly the clone shape this
system uses**, is a footgun aimed at the next person who needs a force push. Deleting it also
closes the last open finding in
[program-b-final-review-followups.md](program-b-final-review-followups.md) outright.

Sequencing note: must land **after** the settings-workspace plumbing PR, which owns
`git-manager.ts`.

### ~~7. [LOW → raised] `repair-metadata` silently resets authorization state~~

**RESOLVED (PR #226) — the response now reports exactly what was reset. Repair still resets rather than salvaging, deliberately: `branch.json` is written atomically, so a corrupt file is not truncation debris, and reconstructing ACLs from bytes that failed `JSON.parse` would silently reinstate possibly-wrong access.**

`api/admin-branch-health.ts:323-423`. Repair archives the corrupt `branch.json` and recreates
defaults, so the recreated metadata gets `status: 'editing'` (a `submitted` branch comes back
**unlocked**), `access: {}` (ACLs dropped), and `createdBy: req.user.userId` (the repairing admin
inherits the creator grant). The admin gets a 200 and nothing says any of it happened.

**Raised above LOW, 2026-08-13.** The reviewer scoped the severity conditionally — "fails closed
under `defaultBranchAccess: 'deny'`, widens access under `'allow'`". The August baseline review's
compound finding CF4 established that **`'allow'` is what `canopycms init` scaffolds**, and all
three apps use it. So the widening case is the _default_ case, not the exotic one. JP agreed to
the raise.

Fix: report what was reset (or state it in the confirm modal) so the admin knows to re-apply the
ACL and re-submit. Separately worth deciding whether repair should preserve a recoverable
`status`/`access` from the archived file when it is partially parseable. The forensic archive
means the old values are recoverable, which is the right design.

### ~~9. [NIT] `utils/error.ts`'s docstring recommends the one idiom the worker invariant bans~~

**RESOLVED (PR #227) — now shows `canopyLogError`. It was the only offending docstring in `utils/`.**

`utils/error.ts:19` shows `console.error('Operation failed:', getErrorMessage(err))` as the usage
example, in a module that **is** in the worker's runtime import closure. Lint would catch a
copy-paste into worker-reachable code, so nothing is at risk — but the canonical example for the
canonical error helper contradicts the invariant PR #211 spent real effort establishing. Change to
`canopyLogError`.

---

## Deferred by decision

### 5. [MEDIUM — design call, LOGGED ONLY] `workflow_dispatch` publishes signed npm artifacts from unreviewed code

`publish.yml`'s `workflow_dispatch` → `prerelease` job. The only gate is
`GITHUB_REF != refs/heads/main`. Everything else — the source, `pnpm install --frozen-lockfile`
against that branch's lockfile, the five `prepack` builds — comes from a branch that by
construction has not been reviewed. The `int` dist-tag and npm's prerelease-exclusion semantics
protect _adopters on `latest`_; they do not constrain _what gets published under this package name
with a valid provenance attestation_.

Stated plainly: **main's branch protection does not bound what reaches npm.**

**JP's call, 2026-08-13: log as future work, not a current concern.** Recorded rather than fixed,
because it is a risk-acceptance question about how open the `int` channel should be, not a defect.
If it is ever to be bounded, the standard lever is a GitHub `environment:` with required reviewers
on the `prerelease` job — roughly one line.

### 8. [LOW] `setBusy` is a shared boolean with concurrent writers and no ref-count

`Editor.tsx:312` and `:370` (reviewer cited `:301`/`:358`; the August epic's editor PR shifted the
lines but left the structure unchanged — **re-verified still live**). Both pass
`setBusy: setEntriesLoading`, so `useEntryManager` and `useDraftManager` write the same flag, and
`useEntryManager` mirrors SWR state onto it unconditionally while the others bracket it manually.
Last writer wins, so a revalidation settling mid-save clears the save's busy state.

Self-correcting within a render or two, so this is spinner flicker rather than a correctness
problem — but the comment "callers that need a busy indicator around an explicit refresh already
bracket `setBusy` themselves" describes a contract the unconditional effect cannot honor. A small
`beginBusy`/`endBusy` counter would make it hold.

Deliberately **not** folded into the editor state-machine PR: that work has landed and is
CI-verified, and reopening it for a cosmetic flicker risks the surface PR #211 rewrote three times
in one day.
