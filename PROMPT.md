# CanopyCMS Codex Prompt (Canonical)

Read packages/canopycms/README.md to understand what we are building from an end-user perspective.

## How to Work

- See `AGENTS.md` (root) and `packages/canopycms/examples/one/AGENTS.md` for day-to-day working agreements. Keep those files and this prompt in sync; update docs when behavior changes.

## Current State (done-ish)

- Config/schema DSL with zod (`defineCanopyConfig`): ordered `schema` array (collections/singletons can be mixed and nested), select/reference/object/code/block fields, default branch settings, media config, optional `contentRoot` (default `content`; collection ids resolve under it). Collection-level `blocks` were removed (blocks live on fields).
- Content store reads/writes MD/MDX/JSON with frontmatter (gray-matter), resolves collection ids as `contentRoot`-prefixed paths, singleton-aware path resolution, traversal guards. Uses `process.cwd()` today (needs branch root wiring).
- Path permissions + branch access helpers (roles admin/manager/editor). Content access checks combine branch + path.
- Branch metadata + registry + workspace manager: persists `.canopycms/branch.json` per branch and `.canopycms/branches.json` at base root; workspace manager ensures metadata/registry entries.
- Git manager abstraction (`simple-git`); createGitManager from services uses config defaults for base branch/remote. Branch workspace creation auto-clones remote for prod/local-prod-sim, requires git bot author identity, and checks out branch.
- Services factory loads config, precomputes access checkers, registry helper.
- Next adapter (`canopycms/next`) wraps API handlers; supports pluggable `getUser`/`getBranchState`; host provides config/services (no auto discovery; config-loader removed). Catch-all Next handler available for minimal setup.
- API handlers for branches (create/list), branch status (get/submit stub), content (read/write), entries listing, assets (local adapter interface). Content/entries currently point at `process.cwd()`.
- Editor UI (Mantine): Editor wrapper with split panes, navigator, branch manager skeleton, form renderer with blocks/select/reference/code/etc., preview bridge with draft updates + click-to-focus/highlight. Drafts persist in localStorage per branch/entry. Editor has experimental client-side entry loading helpers but example currently uses manual entries to avoid client/server boundary issues.
- Example (`packages/canopycms/examples/one`): Next app using `canopycms/client` editor and listEntries API; content endpoints are stubbed only for entries (writes not wired). Example config uses `contentRoot` default with paths like `posts`/`home`; catch-all Next route is in place.
- Branch-aware workspace resolution: `BranchWorkspaceManager`/`loadBranchState` resolve per-branch roots across modes, sanitize names, write metadata + registry, and expose workspace/metadata/base roots on `BranchState`. `resolveBranchWorkspace` can derive roots from state.
- Content/entries APIs now read/write from the branch workspace root (not `process.cwd()`), and `submitBranchForMerge` writes metadata and commits/pushes pending changes via GitManager before marking submitted.
- Catch-all integration test exercises full flow (branch create, content read/write, entries list, submit) against a real on-disk bare remote + clone; verifies pushed content.
- Editor fixes: dynamic header height measurement prevents overlap; preview iframe fills pane without vertical offset; schemas flow through entry refresh.
- Minimized adopter work (specify config, make a catch all API route that defers to Canopy, make an Edit page that defers to Canopy's editor page, load data in views using Canopy helpers)
- content write/save/load works end to end

## Prioritized Backlog

1. **Submission/review workflow**
   - Bot-driven commit/push + PR creation; update branch metadata/registry status.
   - Reviewer flow: request changes/unlock, lock on submit, include PR URL/number.
   - Decide worker vs in-request for git/PR; keep abstraction so either works.
   - We are only targeting GitHub to start.
   - PR submission uses Octokit with bot PAT; creates branch commits, pushes, and opens/updates PRs; submission locks editing until withdrawn (draft PR), reviewer requests changes, or after rejection/merge.
   - Consider https://www.npmjs.com/package/@simulacrum/github-api-simulator to help test interactions with GitHub.
   - Comment threads stored as `.canopycms/comments.json` inside the branch clone (non-committed by default; pluggable storage if persistence beyond the clone is needed). Bot can mirror to PR comments if desired.
   - Post-merge: close/delete remote branch, mark branch clone read-only or archived; keep minimal metadata for history.
   - Show GitHub diff link to reviewers; basic status polling.
   - Submission locks branches; withdraw or reviewer “request changes” re-opens (draft PR) to prevent reviewers seeing moving targets.
1. **Auth**
   - Wire `canopycms/next` handlers to external pluggable auth, provide plugin for Clerk (see `reference/prototype`); enforce admin/manager/editor roles on branch + path access; middleware examples for Next.
   - Add guarded-route examples/snippets; ensure errors surface useful permission info.
   - Access rules per path tree (`content/access.json` generated from config) enforced during read/write.
   - Branch metadata carries authorized users/groups; admins override. Path permissions come from config -> generated access manifest and are not editor-editable (admin-only if edits are allowed).
   - User/group/org name mapping hooks for host app to refresh display names.
   - Permission checks for branch access and per-path rules; consistent error responses; admin bypass and admin-only editing of access manifest.
1. **Schema Updates**
   - Provide utilities to let statically generated public site create tables of contents / trees from this ordering.
1. **Asset adapters**
   - Add S3 adapter with presigned uploads; add LFS adapter surface. Keep local adapter for dev/tests.
   - `AssetStore` interface with methods `list`, `upload`, `delete`, `getSignedUrl`; default local adapter for dev, S3 adapter for production (abstract enough to support others later, including Git LFS-aware flow if needed).
   - Enforce permissions and public URL building.
   - Media references stored in content as URLs; uploader handles permission checks and optional image transforms. Uploads use pre-signed URLs in cloud modes; local dev avoids committing assets when prod uses S3.
   - Media manager UI surfaces browsing, search, selection, and deletion according to permissions.
1. **Editor/tests polish (after above)**
   - Make sure we can handle relational data (e.g. authors defined in their own collection, and referencing to them from blog posts)
   - Navigator search/add/delete; branch manager UX; preview guards/debounce; defaults from schema; more tests/stories.
   - Ensure layout/components continue to use Mantine theme helper.
   - add a loading guard to prevent any flash, debounce draft updates, and keep bracketed path mapping solid.
   - See if we can DRY up the Mantine code by using reusable components (either from mantine.dev or that we make using internal Mantine components)
   - Validation/error display strategy.
   - Add Mermaid support
   - Add coding widget (Monaco or similar)
   - Add MDX support (mdx-editor)
   - Support filtering by collection/status in entry listing
   - Add keyboard shortcuts for common actions
   - Figure out how to use `gray-matter` (so far, we are JSON heavy)
   - Add a type-smoke test that renders `Editor` with a minimal entry and runs `tsc --noEmit`/type assertions so API shape mismatches (e.g., preview URL builder) are caught in CI.
   - TODO: Decide if `normalizeContentPayload` should merge a top-level `body` when both nested `{ format, data, body }` and sibling `body` fields are present (today the top-level value is ignored).
   - TODO: Refine preview base defaults derived from config (e.g., allow overrides, better singleton/root handling, and clarify trailing-slash behavior so preview URLs are predictable).
1. **Sync and conflict surfacing**
   - Background/scheduled sync from main; mark branches needing pull or in conflict.
   - Git strategy: rebase from main by default with conflict detection; merge fallback if needed.
   - UI to show conflicts; helper to abort/resolve is out of scope initially but detection/reporting is in.
1. **Observability & safety**
   - Structured logs for git operations, sync, and permission checks. Feature flags and timeouts for long-running git tasks.
1. **Customizability**
   - Custom form fields: host apps can register components for field `type` strings (e.g., `codeEditor` using Monaco) when a built-in widget isn’t provided or they want to override styling/behavior.
   - The package provides default widgets and example stories; host apps can override per field type via a registry.
1. **Cleanup**
   - Look for opportunities to clean up the code, DRY up the code. Look for opportunities to use external libraries in place of code we have written.
   - Harden the security of the code. Check that all API permissions are correct and that we have control over who is doing what.
1. **Add cache if needed**
   - See how performance is and see if a cache is needed. If so add, e.g. Valkey.
1. **Other Framework Support**
   - Make sure Next.js support is isolated and accessed via abstract mechanisms so that other frameworks can have adapters built

## Notes for Codex

- When items appear in both Current State and Backlog, backlog describes the remaining work to make them “really done.”

Ask any questions you have. After all of your questions have been answered, propose your next work.
