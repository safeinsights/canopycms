# CanopyCMS Backlog

Prioritized work items for CanopyCMS development. See [AGENTS.md](AGENTS.md) for project goals and working agreements.

## Prioritized Backlog

### 1. Submission/review workflow

- Bot-driven commit/push + PR creation; update branch metadata/registry status
- Reviewer flow: request changes/unlock, lock on submit, include PR URL/number
- Decide worker vs in-request for git/PR; keep abstraction so either works
- Targeting GitHub only to start
- PR submission uses Octokit with bot PAT; creates branch commits, pushes, and opens/updates PRs
- Submission locks editing until withdrawn (draft PR), reviewer requests changes, or after rejection/merge
- Consider [@simulacrum/github-api-simulator](https://www.npmjs.com/package/@simulacrum/github-api-simulator) for testing
- Comment threads stored as `.canopycms/comments.json` inside branch clone (non-committed by default; pluggable storage if persistence beyond clone is needed)
- Bot can mirror to PR comments if desired
- Post-merge: close/delete remote branch, mark branch clone read-only or archived; keep minimal metadata for history
- Show GitHub diff link to reviewers; basic status polling
- Withdraw or reviewer "request changes" re-opens (draft PR) to prevent reviewers seeing moving targets

### 2. Comment integration testing

- Full workflow test: create thread → add reply → resolve
- Test file: `packages/canopycms/src/editor/comments/CommentFlow.integration.test.tsx`
- Key test points: comment store updates, UI reflects state, thread sorting (unresolved first), resolve permissions, error states
- Setup: mock comment-store, mock user auth, test entry data, MantineProvider wrapper

### 3. Comment edge case testing

- Single thread: no navigation arrows, no "1/1" counter, still show "+ New"
- Many threads (10+): boundary navigation, counter accuracy, scrolling performance, peekaboo preview
- Peekaboo rendering: 50px sliver of next thread, works at end of carousel
- Resolved filtering: unresolved first, then by createdAt
- Empty states: field with 0 threads shows "Comments • + New", entry/branch empty states
- Nested fields: deeply nested paths (`blocks[2].items[3].title`), block reordering preserves comments, block deletion preserves comments (orphaned but not lost)
- Files: `ThreadCarousel.test.tsx`, `FieldWrapper.test.tsx` (may need to create)

### 4. Entry and branch comments testing

- EntryComments: renders at top of form, uses ThreadCarousel, filters correctly (type === 'entry' && entryId matches), creates entry-level thread (no canopyPath)
- BranchComments: renders in BranchManager, uses ThreadCarousel, filters correctly (type === 'branch', no entryId)
- CommentsPanel: "Jump to entry" scrolls to form top, "Go to branch" opens BranchManager, threads grouped correctly
- Test files to create: `EntryComments.test.tsx`, `BranchComments.test.tsx`

### 5. Comment UI polish

- ThreadCarousel loading states: "Create Thread" spinner, disable "+ New" while submitting, skeleton placeholder
- InlineCommentThread: already has `isSubmitting` for Reply/Resolve buttons
- Optimistic updates: add comment to UI before API confirms, rollback on error
- Use Mantine `Skeleton`, `Loader`, Button `loading` prop

### 6. Comment context

- Link PR comments to form fields
- Click link from PR comment → navigate to form field in editor

### 7. Schema utilities

- Provide utilities for statically generated sites to create tables of contents / trees from schema ordering

### 8. Asset adapters

- `AssetStore` interface with methods: `list`, `upload`, `delete`, `getSignedUrl`
- S3 adapter with presigned uploads for production
- LFS adapter surface
- Local adapter for dev/tests
- Enforce permissions and public URL building
- Media references stored in content as URLs; uploader handles permission checks and optional image transforms
- Uploads use pre-signed URLs in cloud modes; local dev avoids committing assets when prod uses S3
- Media manager UI: browsing, search, selection, deletion according to permissions
- Wire `imagePlugin({ imageUploadHandler })` in MDXEditor to AssetStore so users can upload images directly from the editor toolbar

### 9. Editor polish

- Relational data: authors defined in their own collection, referencing from blog posts
- Navigator: search/add/delete entries
- Branch manager UX improvements
- Preview: guards/debounce, defaults from schema
- Loading guard to prevent flash
- Debounce draft updates
- Keep bracketed path mapping solid
- DRY up Mantine code with reusable components
- Validation/error display strategy
- Mermaid support
- Monaco code widget
- MDX support (mdx-editor)
- Filtering by collection/status in entry listing
- Keyboard shortcuts for common actions
- Figure out gray-matter usage (currently JSON heavy)
- Type-smoke test: render Editor with minimal entry, run `tsc --noEmit` to catch API shape mismatches
- TODO: Decide if `normalizeContentPayload` should merge top-level `body` when both nested `{ format, data, body }` and sibling `body` present
- TODO: Refine preview base defaults from config (allow overrides, better root entry handling, clarify trailing-slash behavior)

### 10. Sync and conflict surfacing

- Background/scheduled sync from main; mark branches needing pull or in conflict
- Git strategy: rebase from main by default with conflict detection; merge fallback if needed
- UI to show conflicts
- Helper to abort/resolve is out of scope initially, but detection/reporting is in
- **Infrastructure done**: CmsWorker.syncGit() + rebaseActiveBranches() handles background sync and conflict detection.
- **UI done** (git-admin-observability epic, 2026-07): branch list shows sync-failed/pending-sync/conflict badges to all users; per-entry conflict notices were already in the editor.

### 11. Observability & safety

- **Done** (git-admin-observability epic, 2026-07): admin System health panel (worker liveness + self-reported status file, task-queue inspection with retry/delete, branch-health scan with purge/repair, persistent per-branch rebase-failure records); worker logs ship to CloudWatch (PR #145).
- Remaining: structured logs for permission checks; feature flags and timeouts for long-running git tasks (task/simple-git timeouts exist; no flags).

### 12. Customizability

- Custom form fields: host apps register components for field `type` strings (e.g., `codeEditor` using Monaco)
- Package provides default widgets and example stories
- Host apps override per field type via registry

### 13. Cleanup

- DRY opportunities
- External library substitutions for bespoke code
- Security hardening: verify all API permissions, control over who does what

### 14. Caching

- **Auth caching done**: CachingAuthPlugin + FileBasedAuthCache for networkless Lambda operation
- **User metadata caching done**: Auth cache populated by worker daemon (Clerk or dev auth)
- Remaining: Evaluate if additional caching needed (content reads, computed data) based on performance

### 15. Mantine button test investigation

- 4 tests skipped due to jsdom async issues
- Research Mantine testing patterns (docs, GitHub issues, community solutions)
- Alternatives: test state changes directly (bypass button click), mock Mantine Button, use Playwright/Cypress for E2E
- Evaluate cost/benefit: 98.3% coverage is high, functionality works in production
- Files: `InlineCommentThread.test.tsx` (2 skipped), `ThreadCarousel.test.tsx` (2 skipped)

### 16. Migrate command: source-specific ordering conventions

- `canopycms migrate` handles the generic rename + `.collection.json` scaffold; order defaults to alphabetical
- Add opt-in support for common source conventions (e.g. Nextra `_meta.json` → `order` + labels)
- Reference implementation: docs-site-proto's `scripts/migrate-content.ts`

### 17. Preview error channel: field-level outline

- `reportError(message, fieldPath)` surfaces an alert over the preview pane (done)
- Follow-up: when `fieldPath` is present, also outline/highlight the matching form field (reuse the click-to-focus mechanics)

### 18. Converge workspace origin URL when opening existing workspaces

- `ensureRemote` only runs on workspace creation; a workspace with a legacy/wrong origin (e.g. pre-prod-sim-rename artifact pointing at real GitHub, observed by docs-site-proto) keeps it forever
- Consider re-running remote configuration on workspace open (cost: extra git calls per request) or a one-time startup sweep over `content-branches/*`

### 19. Bounded concurrency for content listing (only if EFS throttling appears)

- Content listing fans out file reads with **unbounded** `Promise.all`: across collections (`content-listing.ts` `listEntries`, `api/entries.ts` non-recursive + recursive paths) and across files within a collection (`content-listing.ts` `listCollectionEntries`). The editor's initial entry list (no `collection` param) reads every entry file in the whole content tree concurrently.
- This is **intentional and consistent** across all listing sites (verified in branch review of `fix/entries-list-perf-and-loading-state`, 2026-06); it is the point of the per-request batch-auth optimization. `MAX_ENTRIES_PER_PAGE` caps the response, not the FS fan-out. On local FS (dev) it is fine.
- Risk is prod EFS only: a very large tree could hit throttling / EMFILE. **Do not band-aid one call site** — if it ever bites, add a single shared bounded-concurrency helper (e.g. `p-limit`, ~16–32) applied uniformly to all three listing sites. The repo has no concurrency helper today, so this is a deliberate, holistic change.

## Completed

- **Deployment Infrastructure** ✅
  - Lambda + EFS + EC2 Worker architecture (~$5-9/month, no NAT Gateway)
  - `remote.git` auto-detection (aligns prod with dev bare repo pattern)
  - Auth caching: `CachingAuthPlugin` + `FileBasedAuthCache` for networkless operation
  - Clerk + dev auth both support token verifiers and cache writers
  - Async task queue for GitHub operations (file-based on EFS)
  - `CmsWorker` daemon (auth-agnostic, cloud-agnostic, in canopycms core)
  - CDK constructs: `CanopyCmsService` + `CanopyCmsDistribution`
  - Bootstrapping: `npx canopycms init` + `npx canopycms init-deploy aws`
  - Worker CLI: `npx canopycms worker run-once` for dev
  - See [docs/deploying-to-aws.md](docs/deploying-to-aws.md)

- **Other Framework Support** ✅
  - Next.js code abstracted into `canopycms-next` package
  - Core `canopycms/http` module provides framework-agnostic types and handler
  - Auth plugins use generic `CanopyRequest` interface
  - New adapters (Express, Hono, etc.) just need to convert request/response types

## Notes

### Test Environment Limitations

4 skipped tests involve Mantine Button async onClick in jsdom:

- "allows adding a reply"
- "calls onResolve when resolve button is clicked"
- "opens new thread box when New button clicked"
- "displays error when comment creation fails"

All functionality works in production.
