# CanopyCMS Baseline Review Report — July 2026

**Reviewed**: `main` @ v0.0.54 (commit `9e5c517`), all 5 packages (~92k LOC core + satellites), lighter pass on example apps.
**Method**: 14 scoped review agents (typecheck/lint/tests, known-issue verification, client/server boundary, security & authz, API layer, schema/validation/config, content store & git, modes/worker/CLI/CDK, adopter surfaces, editor core, editor UI, hygiene), followed by first-hand verification of all Critical/High findings by the lead reviewer and cross-domain triangulation.
**Prior baseline**: April 2026 review filed issues under `.claude/future-tasks/`; this review re-verified those against HEAD (status below) and focused new effort on the ~18k lines changed since.

---

## Executive summary

The codebase has a strong engineering foundation with disciplined boundaries, but is **not launch-ready**: there are independent P0 blockers across security, schema handling, and the AWS deploy shape.

**Positives (well-calibrated, verified):**

- Clean client/server boundary — server deps are correctly `import type`-only in the editor; no `node:fs` in client-reachable code.
- Central authentication before provisioning; all authz decisions server-enforced (no client-trusted authz).
- No XSS sinks: no `dangerouslySetInnerHTML`/`innerHTML`/`eval` in editor UI; editor-controlled links sanitized (`sanitizeHref`); markdown escaping handled.
- No editor CSS leakage into host apps (scoped styles only).
- Branded path types with containment guards on the _content_ write path.
- Only 3 `any`s, all eslint-disabled and commented. Typecheck, lint, and CI all green.

**Problem concentrations:**

1. Auth fail-open in prod (SEC-C1).
2. Path-traversal filesystem write on the schema-mutation path — the content path already guards against this (SCH-C1).
3. A validation vacuum: no client-side validation, no write-boundary validation, and block-nested fields invisible to every validator (ED-H1 × content-store-validation × SCH-H-block).
4. A CDK config that cannot boot on AWS (DEP-C1, DEP-C4).
5. EFS multi-process concurrency: the still-open P0 index staleness plus several cache-regeneration races.

**Severity rollup (new findings, verified):** 6 Critical, ~15 High, ~18 Medium, ~15 Low, plus hygiene debt.
**Prior review status:** 2 filed issues now fixed; the filed P0 (index staleness) is still open.

---

## Compound findings (cross-domain triangulation)

1. **[COMPOUND-1] Remote arbitrary file write in a fail-open prod = SEC-C1 × SCH-C1 (× UI-M3).** SEC-C1 lets an unauthenticated attacker become admin (`X-Test-User: admin`) when `CANOPY_AUTH_MODE` is unset/wrong in prod. Once admin, SCH-C1's `createCollection` path traversal writes files anywhere the process can reach (EFS/worker). UI-M3 shows the name field is user-editable. The chain is unauth → admin → arbitrary FS write. Either fix alone breaks the chain; both are must-fix.
2. **[COMPOUND-2] Silent bad data reaches the public site = ED-H1 × content-store-validation (filed) × SCH-H-block × SCH-H3.** No client validation + no write-boundary validation + block-nested fields invisible to validators + `maxItems` unenforced: a user saves incomplete/duplicate/dangling content, sees green "Saved", the server accepts it, and the static build breaks or the page renders empty. One validation layer must become authoritative (recommend the write boundary, reusing field-traversal — but the block-shape bug must be fixed first or traversal still misses block content).
3. **[COMPOUND-3] Dangling references survive deletion = SCH-H-block × deletion safety.** Block-nested references are invisible to DeletionChecker, so an entry referenced only from inside a block can be deleted → dangling reference → broken build. Same root cause as COMPOUND-2 (the `_type` vs `{template, value}` bug); fix once.
4. **[COMPOUND-4] Prod is non-functional on multiple independent axes.** DEP-C1 (Lambda can't mount EFS) + DEP-C4 (worker crash-loops) + filed P0 index staleness (wrong-file saves) + SEC-C1 (fail-open auth). Any one blocks a safe launch on the documented AWS shape; they are independent, so all four gate go-live.
5. **[COMPOUND-5] Error-handling gaps stack = API-C1 × API-H2.** No top-level catch (raw throws escape as generic Next 500s, breaking the `{ok, status, error}` contract the editor parses) + where errors ARE caught they're unsanitized (absolute paths and `x-access-token:…@github.com` git credentials can leak to authenticated clients). Fix together: one top-level catch that sanitizes.
6. **[CONFIRMED-by-2] GIT-H1/DEP-C3** — non-idempotent PR submit was found independently by both the content-store and worker review agents (direct path and worker path). High confidence; both paths need `createOrUpdatePR`.

---

## Critical findings (verified first-hand)

### [SEC-C1] Fail-open auth: prod can silently run unauthenticated dev auth

`cli/templates.ts:45-48` generates the adopter `canopy.ts` with `process.env.CANOPY_AUTH_MODE === 'clerk' ? createClerkAuthPlugin(...) : createDevAuthPlugin()` — selection keyed on an env var, NOT `config.mode`. `context-wrapper.ts:205-214` wraps whatever plugin it receives with no `mode === 'prod'` rejection. `dev-plugin.ts:44` trusts `X-Test-User`/`x-dev-user-id`/cookie with zero verification, and `mapTestUserKey('admin') → DEV_ADMIN_USER_ID`, which is auto-bootstrapped admin (`dev-plugin.ts:166-170`).
**Impact:** a prod deploy where `CANOPY_AUTH_MODE` is unset, misspelled, or dropped accepts `X-Test-User: admin` from anyone — full admin.
**Fix:** fail closed in prod — core guard in `createNextCanopyContext`/`createCanopyServices` throws if a dev/no-verify plugin is used with `mode === 'prod'`; the template should throw when Clerk config is missing rather than silently falling back to dev auth.

### [SCH-C1] Path-traversal filesystem write in `createCollection` (admin-gated; compounds with SEC-C1)

`schema-store.ts:294-327`: `createCollectionInputSchema.name` (`:94`) is `z.string().min(1).max(64)` with no character restriction; the handler builds `path.join(parentPhysicalPath, `${name}.${contentId}`)` and runs `fs.mkdir(recursive)` + writes `.collection.json` with no `startsWith(contentRoot)` guard. `name = "../../../../tmp/evil"` writes anywhere the process can reach.
**Asymmetry:** `updateCollection` slug rename DOES enforce `/^[a-z][a-z0-9-]*$/` (`:444`); `content-store.ts:311` has the analogous guard for content writes; `createCollection` is missing both.
**Fix:** validate the name against the safe slug pattern + assert the resolved physical path is within `contentRoot` before mkdir.

### [DEP-C1] Lambda cannot mount EFS: security group missing egress (prod won't boot)

`cms-service.ts:148-155`: `lambdaSg` is `allowAllOutbound: false` with only the EFS _ingress_ rule; the Lambda _egress_ rule to EFS:2049 is absent. The worker correctly has both (`:189-190`). Every Lambda request fails to reach `/mnt/efs`.
**Fix:** `lambdaSg.addEgressRule(efsSg, ec2.Port.tcp(2049))`.

### [DEP-C4] Worker crash-loops: `@aws-sdk` externalized from bundle but never installed on EC2

`build:worker` esbuild uses `--external:@aws-sdk/*` (`package.json:33`); `worker/index.ts:20-21` does a runtime `await import('@aws-sdk/client-secrets-manager')`; the SDK is a devDependency only; the S3 asset is just `worker/dist` (`cms-service.ts:222`, no `node_modules`); UserData (`:243-279`) installs nodejs, copies the bundle, and runs `node index.js` with no npm install. In the documented secret-ARN config, `getSecret()` → "Cannot find module" → systemd `Restart=always` crash-loop → no branch is ever pushed or PR'd.
**Fix:** drop `@aws-sdk/*` from esbuild `--external` (bundle it) or npm-install on the host.

### [DEP-C2] Worker lock PID check unsound across hosts (agent-reported; verify before fix)

Two workers could double-process the queue. Not yet first-hand verified — verify as part of the fix branch.

### Index staleness multi-process (filed P0, April 2026 — still OPEN)

`indexLoaded` one-shot flag in `content-store.ts:124,137-141` is never reset after `pullBase`/rebase/checkout; no `validateIndex()` exists. Only the slug-change orphan-file sub-issue was fixed (`content-store.ts:527-536`). Cross-process (Lambda + worker on EFS) divergence compounds every other concurrency issue.

---

## High findings

### Security & authorization

- **[SEC-H1] Privilege escalation via provider-supplied group names.** `user.ts:94` seeds `groups` from `authResult.user.externalGroups`; `authorization/helpers.ts:31,38` grant admin/reviewer by `groups.includes('Admins'/'Reviewers')`. Reserved IDs are unprefixed and guessable; nothing strips them from externalGroups. Any provider with human-controllable group identifiers (a Clerk org _named_ Admins, a GitHub team, SAML/LDAP group) → self-escalation. Mitigated today only because the shipped Clerk plugin maps opaque `org_…` IDs. **Fix:** derive privilege solely from internal groups + `bootstrapAdminIds`; strip reserved IDs from externalGroups before merge.
- **[SEC-H2] `parseBranchName` permits leading `-` → git argument injection.** `paths/validation.ts:278-322` rejects `..`, slashes, spaces, control/`~^:?*[\` chars, but not a leading `-`. Confirmed reachable: names flow into `git.checkout(branch)` (`git-manager.ts:609`), `checkoutBranch` (`:620`), `checkout(['-B', branch, base])` (`:625`), and the push refspec (`:701`) — no `--` separator at any call site. simple-git uses spawn (no shell), so not shell RCE, but git treats leading `-` as options (classic option injection). **Fix:** reject names starting with `-`; disallow bare `HEAD`/`@`; add `--` separators at git-manager call sites.
- **[SEC-H3] Route precedence: `DELETE /:branch` shadows `DELETE /assets`.** The router matches first-in-declaration-order (`router.ts:145-162`); BRANCH_ROUTES are registered before ASSET_ROUTES (`router.ts:74-86`). `DELETE /assets` matches the branch pattern `[':branch']` with `branch = 'assets'` and never reaches admin-guarded `deleteAsset` (`assets.ts:135-145`). Asset deletion is dead code; the general class is a dynamic route shadowing a differently-guarded static route (latent authz bypass). **Fix:** match static segments before dynamic regardless of registration order.

### API layer

- **[API-C1→H] No top-level error boundary in the core request handler.** `handler.ts:153-306` only try/catches `getBranchContext` (`:200-217`); `getContext()`, `refreshActiveBranch()`, `authenticate()`, and `match.handler()` are unguarded. The Next adapter (`adapter.ts:89-105`) has no catch around `coreHandler`, so unhandled throws escape as generic Next 500s, breaking the uniform `{ok, status, error}` contract the editor depends on. Several handlers already `throw err` raw (`content.ts:178`, `entries.ts:250`, `schema.ts:138`). (Downgraded from Critical: prod Next hides the stack, so this is a contract/robustness break, not a stack leak.) **Fix:** wrap the handler body in one top-level try/catch → sanitized 500 envelope.
- **[API-H3] `apiCtxPromise` caches a rejected promise forever.** `handler.ts:157-163`: the first `buildContext()` rejection (transient cold start / EFS not mounted) leaves `apiCtxPromise` non-null, so every future request in that warm Lambda container re-throws the same rejection until the container is recycled. **Fix:** reset `apiCtxPromise = null` on rejection.
- **[API-H1] Settings commit/push failures silently swallowed; endpoint still returns 200.** `settings-helpers.ts:38-70` (`commitSettings` returns void, only `console.warn` on push failure); callers `permissions.ts:139-147` and `groups.ts:256-264` return 200 regardless — an admin permission change is reported saved but never pushed/PR'd, and is lost on redeploy. **Fix:** return a pushed/error flag; surface non-200.
- **[API-H2] Inconsistent error sanitization; internal paths and git credentials can leak to authenticated clients.** `sanitizeErrorMessage()` (`utils/error.ts:48`) is used only at `handler.ts:213`; raw `err.message` is interpolated everywhere else, including `branch-status.ts:51-56` (absolute branchRoot + raw git error, which can contain `x-access-token:tok@github.com`), `permissions.ts`, `groups.ts`, and `schema.ts` mutations. **Fix:** route all caught errors through `sanitizeErrorMessage`.
- **[API-H4] Client-generation drift for assets endpoints.** Assets list/delete take query params (`prefix`/`key`) validated inside the handler, but no `params:` schema on `defineEndpoint`, so `generate-client.ts:69` emits no-arg client methods — the generated `assets.delete()`/`list()` can't pass `key`/`prefix` and always 400. **Fix:** declare the query params schema so the generator emits arguments.

### Content store & git

- **[GIT-H1 / DEP-C3] Submit is not idempotent; a created-but-unrecorded PR orphans it and wedges sync forever.** `github-sync.ts:52-64` (direct path) calls `createPullRequest` (422s if the PR exists) instead of the idempotent `createOrUpdatePR` sitting beside it (`github-service.ts:83`); the PR is created before `meta.save()` persists `pullRequestNumber`. If `meta.save()` fails or the process dies in between, GitHub has the PR but Canopy lost its number → the next submit 422s → `syncStatus: 'sync-failed'` permanently. The worker path has the same defect (retries via `retryTask` but `createPullRequest` still 422s). Confirmed independently by two review agents. **Fix:** use `createOrUpdatePR` in both paths; persist the PR number in the same critical section as the status.

### Schema / validation / config

- **[SCH-H-block] Block-nested fields invisible to all validation and deletion safety (compound, materially worse than filed).** `field-traversal.ts:41` and `deletion-checker.ts:190` look up the block template by `item._type`, but real block data is `{template, value}` (`BlockField.tsx:28-30`; `addBlock` at `:123` emits `{template, value: {}}`; `content-store.ts:865` reads `b.template`/`b.value`). `getBlockTemplateFields` returns undefined for every real block, so `findFieldsByType` (ReferenceValidator + EntryLinkValidator via `entry-link-validator.ts:47`) and DeletionChecker skip ALL block-nested content. Consequences: block-nested reference IDs never validated on save; an entry referenced only inside a block can be deleted (dangling ref); block-nested entry links get no orphan warnings. Only `json-to-markdown.ts:475` (`_type || template`) and the content store handle the real shape. Filed as deletion-checker-refactor but understated there. **Fix:** make traversal read `{template, value}`.
- **[SCH-H1] `mediaSchema` is `z.union`, not `z.discriminatedUnion`.** `config/schemas/media.ts:8-27` — the generic branch swallows malformed S3 config: `{adapter: 's3', bucket: 'x'}` parses OK with `bucket` stripped and `region` absent, no error (verified against zod). **Fix:** `discriminatedUnion('adapter')`.
- **[SCH-H2] `composeCanopyConfig` silently drops typed fragment keys.** `config/helpers.ts:104-185` — the merge loop never reads `githubTokenEnvVar`/`deployedAs`/`settingsBranch`/`autoCreateSettingsPR`/`editor`/**`authPlugin`**/`entryLinkUrl`/**`validateEntry`** from fragments even though `CanopyConfigFragment` types them (and JSDoc encourages putting them there) — auth/validation silently doesn't run. Deeper than the filed dead-spread issue. **Fix:** spread the whole fragment or enumerate all keys.
- **[SCH-H3] `EntryTypeConfig.maxItems` never enforced server-side.** (`types.ts:171`) Only the editor "Add" button gates client-side; a direct API create (or two racing editors) makes a second singleton despite `maxItems: 1`. **Fix:** enforce in `api/entries.ts` / content-store by counting existing entries.

### Editor

- **[ED-H1] No client-side validation anywhere before save (compound).** `FormRenderer.tsx` just renders and propagates onChange; `useDraftManager.handleSave` (`useDraftManager.ts:149-181`) and `useEntryManager.saveEntry` (`:208-251`) have zero validation — required/type/format/min-max/non-empty-reference are unenforced in the UI. The only check is the adopter's OPTIONAL server `validateEntry` hook. Compounds with the filed content-store-validation gap and SCH-H-block. **Fix:** schema-driven validation pass in handleSave (reuse field-traversal) blocking save with per-field errors.
- **[UI-H1] New groups all share `id: ''` → membership bleeds across unsaved groups; delete-all.** `group-manager/hooks/useGroupState.ts:43-52` `createGroup` sets `id: '' as CanopyGroupId`; `updateGroup`/`deleteGroup`/`addMember`/`removeMember` all match `g.id === groupId`. The UI's batch-save model (`index.tsx:76-90`) makes "create A + members, create B + members" a normal flow → `addMember('', userB)` matches BOTH A and B; `deleteGroup('')` deletes both. Corrupts group membership → wrong permission inheritance (groups drive authz). **Fix:** assign a temp unique client id on createGroup; reconcile to the server id on save.

### Adopter surfaces

- **[ADO-H1] Dual-build deploy shape has zero example-app or build-level verification.** No app uses `CANOPY_BUILD`/`.server.ts`; `init.test.ts` only asserts template STRING content, never runs `next build` with `CANOPY_BUILD=static/cms`. A regression in `withCanopy()` pageExtensions exclusion or the `deployedAs` conditional wouldn't be caught pre-prod. **Fix:** dual-build fixture running both builds in CI (punted to future-task; larger effort).
- **[ADO-H2] `apps/example1/tsconfig.json:13-16` `"canopycms/*"` wildcard bypasses the package exports allowlist.** Resolves any subpath into package src; `scripts/generate-author-ids.ts` imports `canopycms/paths` (not exported) — real Node throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, but `tsc --noEmit` passes falsely. Masks touchpoint creep; the script is orphaned and broken. test-app has no such override. **Fix:** drop the wildcard, keep exact mapping; delete or fix the script.

### Deployment / worker

- **[DEP-H1] Git subprocess spawns not bounded by `taskTimeoutMs`** — a hung git op stalls the worker (agent-reported; verify with DEP-C2).
- **[DEP-H2] Function URL `authType: NONE`** (`cms-service.ts:174-176`) — publicly reachable with no CloudFront origin verification/OAC; anyone who learns the URL hits the CMS directly. **Fix:** AWS_IAM auth + CloudFront OAC/origin verification.

---

## Medium findings (by domain)

**Security:** `canopycms-auth-clerk` `authorizedParties` optional → cookie replay/CSRF (`clerk-plugin.ts:140-143`), compounds with SEC-C1. `GET /assets` has no privilege guard (known/deferred, still open) — any authed user enumerates all asset keys (`api/assets.ts:102-111` vs `uploadAsset` 'privileged', `deleteAsset` 'admin'). Asset `key` only `z.string().min(1)` at the boundary (`assets.ts:23-27`) — safe today only via LocalAssetStore containment; future S3/LFS adapters may not replicate it.

**Boundary:** [BND-M1] The client/server config split is convention-only. `config/helpers.ts:51-84` `defineCanopyConfig()` returns `{server, client()}` from one module adopters import whole into a `'use client'` page; `.client()` filters only the return value. `CanopyConfigInput` type-permits `authPlugin`/`validateEntry`/`entryLinkUrl` at top level with no guard — if an adopter puts `authPlugin` in `canopycms.config.ts`, server-only Clerk code bundles into the browser. Avoided today only by README/template discipline. **Fix:** type-level split.

**API:** [API-M1] `resolve-references.ts:28` `ids` array unbounded + sequential per-ID file I/O → any authed user forces large sequential FS work; `content.ts` body/data also unbounded. [API-M2] `permissions.ts:46-49,172` `limit: z.string()` + parseInt (NaN unchecked) vs `entries.ts`'s `z.coerce.number().int().min(1)`.

**Git/content store:** [GIT-M1] `branch-registry.ts:44-114` `regenerate()` takes no lock → can resurrect a just-invalidated stale snapshot. [GIT-M2] `branch-schema-cache.ts:162-201` same regenerate-after-invalidate race; prod has no mtime backstop (dev does) → stale schema pinned until the next explicit invalidate. [GIT-M3] `comment-store.ts:179-270` no in-process lock (unlike branch-metadata's `withLock`); reviewer+editor on the same branch is the expected workflow → normal-use contention; root cause of the known flaky comment tests. [GIT-M4] `branch-metadata.ts:145-154` post-write verification omits the 50ms NFS settle that comment-store uses → on EFS two near-simultaneous renames can each read back their own writeId → silent lost update on status/access (Lambda vs worker). [GIT-M5] `github-service.ts` has no rate-limit/secondary-limit/5xx retry; `createOrUpdatePR:98` trusts `data[0]` (could update the wrong PR).

**Concurrency model (context for the above):** in-process = per-abs-path in-memory mutex (content/metadata) + version OCC (metadata/comments); comments have OCC only. Cross-process (Lambda + worker on EFS): the in-memory mutex is useless; serialization = per-file OCC tokens + proper-lockfile used ONLY for provisioning (not content/metadata writes). Breaks at: (1) cache regen without coordination, (2) metadata verify missing the NFS settle, (3) the known content-id index staleness compounds all of it.

**Schema/config:** [SCH-M1] `config/schemas/config.ts:51-52` `defaultBranchAccess`/`defaultPathAccess` wrap `.default('deny')` in an outer `.optional()` → yields `undefined`, not `'deny'` (verified); masked only by consumers' `?? 'deny'`; a future consumer trusting the Zod default fails OPEN. [SCH-M2] No sibling-collection name dedup. [SCH-M3] `title-field.ts` helpers skip block templates. [SCH-M4] `config/schemas` collection/field schemas exported "for advanced use" with zero callers and the wrong (post-resolution) shape vs on-disk `.collection.json`.

**Editor:** [ED-M1] Live preview shows the PREVIOUS entry's content when switching to a non-mounting entry — `Editor.tsx:191` `previewData` is single shared state, never reset on entry change (the effect at `:271-273` clears `previewError` but not `previewData`); when the new entry's FormRenderer doesn't mount (still loading / `canEdit === false` / empty schema), stale previewData persists. **Fix:** reset previewData/previewLoadingState keyed on `currentEntry?.contentId`. [UI-M1] `fields/ReferenceField.tsx:96-101` reference-options load failure = silent empty picker (only console.error); the editor sees a blank control despite a stored value and may clear it. [UI-M2] `schema-editor/CollectionEditor.tsx:262-299,484-496` edit-mode entry-type save closes the modal optimistically without isSaving/error props → server rejection loses the typed-in entry type. [UI-M3] `CollectionEditor.tsx:190-210,356-363` collection `name` freely editable in edit mode; the format regex is gated on `!isEditMode` and the TextInput isn't disabled (unlike EntryTypeEditor) → arbitrary names sent as `updates.name` with only a server-side backstop (compounds SCH-C1).

**Adopter:** [ADO-M1] Generated `middleware.ts` does NOT runtime-switch on `CANOPY_AUTH_MODE`, unlike `lib/canopy.ts` + `edit/page.tsx`; the README claim "handles both providers without regenerating files" is false for middleware. An adopter who init'd with dev and flips `CANOPY_AUTH_MODE=clerk` ships passthrough middleware → `/edit` renders for anonymous users (defense-in-depth redirect gone; clerk-plugin still 401s the API, so not a full breach). [ADO-M2] `lib/canopy.ts` in BOTH example apps is missing the `getCanopyForBuild` that the template + README document (the drift-check apps are themselves stale).

**Deployment:** [DEP-M1] IAM managed EFS policy `Resource: *`. [DEP-M2] The direct-GitHub path is gated by mode+token, not real internet availability → hangs a NAT-less Lambda. [DEP-fork-M1] `Dockerfile.cms` uses `npm ci` despite the pnpm-only convention.

---

## Low findings (abbreviated)

- [SEC-L] `addComment`/`listComments` ignore per-path ACLs (`comments.ts:52-104`); ReDoS on stored content regexes (`entry-link-resolver.ts:156`); dev-plugin mutates `process.env`; catch-all slug not URL-decoded (`router.ts:110-123`).
- [BND-L] `canopycms-auth-clerk` missing react/react-dom peerDeps.
- [API-L1] Entries cursor allows negative offset. [API-L2] `createGitManagerFor` closes over stale config in dev. [API-L3] `jsonResponse` never sets Content-Type.
- [GIT-L1] atomic-write has no fsync. [GIT-L2] `createOrphanSettingsBranch` runs `git rm -rf` without re-checking the managed marker. [GIT-L3] Content OCC uses `mtimeMs` → a coarse-granularity FS can pass a stale write.
- [SCH-L1] Multiple `default: true` picks the first. [SCH-L2] Duplicate block template names → first wins, no check.
- [ED-L1] Branch A→B switch briefly persists A's drafts under B's localStorage key (self-corrects unless the tab closes in the window). [ED-L2] Multi-tab same-branch draft persistence is last-writer-wins → cross-tab unsaved-edit loss.
- [UI-L1] `EntryTypeEditor.tsx:327-332` default switch doesn't unset siblings (same class as SCH-L1). [UI-L2] `BlockField.tsx:97-111` block keys not regenerated when the parent swaps an equal-length block array (masked by MarkdownField's external-value effect).
- [ADO-L1] `example1/AGENTS.md:8` names a `createContentReader` touchpoint the app no longer uses. [ADO-L2] `test-app/next.config.mjs` bypasses `withCanopy()` (e2e never exercises withCanopy bundler logic). [ADO-L3] `adapter.ts:78-86` JSDoc omits PATCH.
- [DEP-L1] Worker retry doesn't distinguish transient (429/5xx) vs permanent (4xx) errors → permanent failures burn the whole retry budget; the Lambda direct path has no retry.
- TEST-INFRA (LOW): no explicit `testTimeout` in `vitest.config.ts` — the git-heavy integration suite relies on the 5s default and is fragile on slower/loaded/macOS machines (see Test verdict).

---

## Test verdict (not a code defect)

`pnpm test` shows 82 "failures" locally — **all 5000ms timeouts on git-heavy integration tests** (branch-workspace, git-manager, permissions/workflow integration). **CI is GREEN on main** (same `pnpm test`, same default 5s timeout, ubuntu-latest). Isolated local reruns confirm the tests are genuinely slow on macOS (`git-manager.test.ts` 70s/45 tests; `role-permissions.test.ts` 64s/13 tests) — macOS git subprocess spawn overhead pushes them past 5s even without contention. Recommendation: raise `testTimeout` for the node/integration project + add a local-dev note.

---

## Known-issue status at HEAD (April 2026 review re-verification)

**FIXED (2):** preview-bridge-security (source+origin checks now in `preview-bridge.tsx:55-60,350-352`); e2e-reset-race-condition (404 on ENOENT in `api/content.ts:174-179` + reset polling gates). Also fixed from the deferred-minor list: `CanopyConfigSchema` `schema` drift; `relativePathSchema` now does a per-segment `..` check.

**PARTIAL (3):**

- **index-staleness-multiprocess (P0): core issue OPEN** — see Critical findings above.
- editor-async-patterns: `useEntryManager` refresh now sequence-guarded; `ReferenceField.tsx:75-103` effect still uncancelled with raw array deps; `useReferenceResolution.ts:178-217` has no generation guard; `Editor.tsx:369-394` entry-load effect unguarded — but `setDrafts`/`setLoadedValues` are keyed by contentId, so a late superseded load does NOT corrupt another entry's data; residual harm is loading flicker + a spurious "Failed to load entry" toast (tempers priority).
- dual-react-problem: `withCanopy()` webpack aliasing implemented (`canopycms-next/src/with-canopy.ts:62-167`); Turbopack confirmed non-functional, documented limitation.

**OPEN (11):** stale-draft-prevents-content-load (`Editor.tsx:372` skips the API when a draft exists); flaky-comment-store-tests (`{retry: 1}` at `comment-store.test.ts:357,389,419` — root cause is GIT-M3); swr (no dedup layer); content-store-validation (no schema validation at the write boundary — part of COMPOUND-2); editor-state-context-migration (`Editor.tsx` now 1310 lines, ~30 useState, EditorStateProvider never wired); next-16.2-postcss-fork-bomb (peer range still allows ^16, no README warning); content-store-lock-key (physical-path lock keys at `content-store.ts:494,602,652`); validate-entry-type-names; deletion-checker-refactor (superseded/expanded by SCH-H-block); getErrorMessage pattern (now worse — see Hygiene); MediaConfig.publicBaseUrl TS/Zod drift; composeCanopyConfig dead spread (`helpers.ts:177` — superseded by SCH-H2); listAssets no guards.

---

## Hygiene (no bug-level findings; quality/maintainability debt)

- **Dead code:** fully orphaned files `editor/env.ts` (isBrowser, 0 imports) and `editor/components/EditorContext.tsx` (49 LOC, superseded by `context/EditorStateContext.tsx`). Orphaned exports: `user.ts:46,52,58` (`isAnonymousUser`/`isAuthenticatedUser`/`createAuthenticatedUser` — and `authResultToCanopyUser` duplicates `createAuthenticatedUser`'s literal → drift risk); several test-utils/fixtures unused; canopycms-cdk devDeps `@octokit/rest` + `simple-git` unused.
- **Test gaps (top risk, untested >70 LOC):** `api/route-builder.ts` (289), `http/router.ts` (164 — the dispatcher every request and the shadowing bug flow through), `operating-mode/client-unsafe-strategy.ts` (219) + `client-safe-strategy.ts` (139), `schema/meta-loader.ts` (377), `authorization/groups/loader.ts` (123) + `permissions/loader.ts` (112), `user.ts` (118), `api/github-sync.ts` (144), `dev-content-watcher.ts` (151), `settings-workspace.ts` (157), `api/reference-options.ts` + `resolve-references.ts`, `validation/entry-link-validator.ts` (79); plus `utils/atomic-write.ts` and `utils/provisioning-lock.ts` — integrity/lock primitives, untested.
- **Deps:** two icon libraries (@tabler/icons-react in 20 files + react-icons in 2); chroma-js is a direct dep with 0 direct imports (only transitive via @mantine/colors-generator); react-split-pane is pre-React-18 (1 use); all 8 `pnpm.overrides` look like CVE/advisory pins but are UNDOCUMENTED — add advisory IDs so the pins aren't accidentally removed.
- **Patterns:** the `getErrorMessage()` ad-hoc pattern is now **46 occurrences / 21 files** (regressed from the filed 32/14); worst: `worker/cms-worker.ts` (9), `useBranchManager.tsx` (5), `api/permissions.ts` (5). `any`: only 3, all eslint-disabled and commented (docs say "one exception" — update to 3). `collection.ts:15` hand-rolls a traversal check instead of using `paths/normalize.ts hasTraversalSequence()` — duplicated security-relevant logic.
- **Lint:** 0 errors; 5 warnings (2 security-regex warns at `entry-link-resolver.ts:156` and `utils/error.ts:64,74`; 2 stale eslint-disable in auth-clerk `cache-writer.ts`).

---

## Remediation plan

Fixes land as small feature branches off the integration branch **`review/baseline-2026-07`**, each reviewed and merged when green (typecheck + lint + relevant tests); the integration branch merges to `main` after user review. Clusters, sequenced P0-first:

- **A — Security (P0/P1):** A1 auth fail-closed in prod (SEC-C1); A2 createCollection traversal guard (SCH-C1 + UI-M3); A3 group privilege escalation (SEC-H1); A4 branch-name arg injection (SEC-H2); A5 router static-before-dynamic precedence (SEC-H3).
- **B — CDK deploy blockers (P0):** B1 Lambda→EFS egress (DEP-C1); B2 bundle @aws-sdk in the worker (DEP-C4); B3 Function URL auth (DEP-H2); B4 worker lock verification + git timeouts + retry classification (DEP-C2/DEP-H1/DEP-L1).
- **C — API robustness (P1):** C1 top-level error boundary + sanitization (API-C1 + API-H2); C2 context retry (API-H3); C3 settings commit failure surfacing (API-H1); C4 assets client params (API-H4); C5 input bounds (API-M1/M2/L1).
- **D — Content & data integrity (P0/P1):** D1 block traversal discriminator (SCH-H-block; folds deletion-checker-refactor); D2 idempotent PR submit (GIT-H1/DEP-C3); D3 content-index invalidation, in-process scope (P0 index staleness; cross-process punted to future-task); D4 write-boundary + client-side validation (COMPOUND-2, requires D1); D5 config schema hardening (SCH-H1/H2/H3/M1).
- **E — Editor UX (P1/P2):** E1 group id bleed (UI-H1); E2 preview reset (ED-M1); E3 reference-field error UX (UI-M1/M2); E4 draft localStorage races (ED-L1/L2).
- **F — Adopter surfaces (P1/P2):** F1 example tsconfig touchpoint (ADO-H2); F2 init middleware auth mode (ADO-M1); F3 example/template sync (ADO-M2/L1/L3); F4 dual-build CI fixture (ADO-H1 — punted to future-task).
- **G — Hygiene (P2/P3):** G1 getErrorMessage sweep; G2 dead code; G3 deps + documented overrides; G4 lint warnings + test-timeout config + auth-clerk react peerDep.

**Punted to `.claude/future-tasks/` (bigger design work):** EFS cross-process concurrency epic (index cross-process divergence, cache-regen races GIT-M1/M2, branch-metadata NFS settle GIT-M4, content-store lock-key) as one coordinated design; test-gap backfill for top-risk untested modules; editor-async-patterns cancellation + SWR dedup + editor-state-context migration; dual-build CI fixture; DEP-C2 worker-HA follow-through.
