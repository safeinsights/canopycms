# CanopyCMS Overall Plan

**Created**: 2024-12-21
**Last Updated**: 2026-03-24
**Status**: Active
**Current Phase**: Asset Adapters (Phase 2) + AI Content

---

## Overview

CanopyCMS is a schema-driven, branch-aware CMS for GitHub-backed content. The system is feature-rich with most core functionality complete. This overall plan tracks the remaining work to reach production readiness.

### What's Complete

Core architecture, editor UI, GitHub PR workflow, auth & permissions (groups-only model), AI-ready content generation (v1), and API modernization (`defineEndpoint()` with Zod validation) are all shipped. See ARCHITECTURE.md for details.

---

## Prioritized Backlog

### 1. Schema Updates & Utilities

**Status**: 75% COMPLETE — only entry sorting remains

**Remaining**:

- **Entry sorting/reordering within collections**
  - Manual drag-and-drop reordering UI
  - Sort by field values (date, title, etc.)
  - Collection metadata for entry order storage
  - API support for updating order
  - UI integration in EntryNavigator

### 2. Asset Adapters

**Estimated**: 2-3 sessions
**Status**: 40% COMPLETE - **CURRENT PRIORITY**

⚠️ **CAVEAT**: The initial asset infrastructure was implemented long ago and needs careful review before extending. Verify assumptions and test thoroughly.

**Completed** ✅: Asset store interface, LocalAssetStore, all API endpoints with permission gating, config schema for local/S3/LFS/custom adapters.

**Remaining Work**:

1. **Review & Verify Existing Infrastructure** (~0.5 sessions):
   - Review LocalAssetStore implementation and test coverage
   - Verify API endpoint edge cases
   - Ensure permission checks are thorough

2. **S3 Adapter Implementation** (~1 session):
   - Presigned upload URL generation
   - S3 client integration
   - PUT upload flow
   - Error handling and validation
   - Write comprehensive tests

3. **Media Manager UI** (~1-2 sessions):
   - Image field renderer in FormRenderer (missing `case 'image'`)
   - Media browsing/search component
   - Upload progress UI
   - Image preview and selection
   - Integration with asset store API

4. **Git LFS Adapter** (~0.5 sessions):
   - LFS pointer file creation
   - Upload flow integration

### 3. Sync & Conflict Handling

**Estimated**: 1-2 sessions remaining
**Status**: Backend complete, UI needed

**Completed** ✅: `CmsWorker.syncGit()` fetches from GitHub on interval, `rebaseActiveBranches()` rebases from origin/main with --theirs conflict resolution, conflict metadata (`conflictStatus`, `conflictFiles`) saved to branch.json, GET `/:branch/status` exposes conflict data. Integration tests in `conflict-resolution.test.ts`.

**Remaining**:

- UI to display conflict status and affected entries in BranchManager/Editor
- Sync-on-demand API endpoint (currently background-only)
- Merge fallback when rebase fails completely (currently aborts safely)
- Conflict resolution workflow UI

### 4. Query Parameter Validation

**Estimated**: 0.5 sessions
**Status**: Low priority

- Extend `defineEndpoint()` to support `query` field with Zod schema
- Update validation logic in `handler.ts` to validate query params separately from path params
- Migrate routes currently using manual validation or params-field workaround:
  - `permissions.ts`: `searchUsers` (uses `params` field for query params — workaround)
  - `groups.ts`: `searchExternal` (same `params` workaround)
  - `assets.ts`: `listAssets`, `deleteAsset` (manual Zod in handler)
  - `reference-options.ts`: `getReferenceOptions` (manual Zod in handler)

### 5. Code Cleanup & Framework Abstraction

**Estimated**: 1-2 sessions
**Status**: Ongoing

- Navigation & ToC generation from schema for static sites
- DRY up repetitive code in editor components
- Extract reusable Mantine components to shared library
- Library evaluation (replace custom code with external libs where beneficial)
- Document adapter API for other frameworks (Astro, SvelteKit, Remix)
- Remove or clarify "standalone" terminology (likely legacy naming)

### 6. Observability & Safety

**Estimated**: 1-2 sessions
**Priority**: Medium-High

- Structured logging for git operations
- Performance monitoring and metrics
- Feature flags system
- Timeouts for long-running tasks
- Security audit (OWASP Top 10 review)

### 7. Editor Polish

**Estimated**: 2-3 sessions
**Priority**: Low-Medium

- Navigator search/add/delete functionality
- Mermaid diagram support in preview
- Monaco code editor integration for code blocks
- MDX editor enhancements
- Keyboard shortcuts
- Collection/status filtering
- Type-smoke tests for API shape verification

### 8. Customizability

**Estimated**: 2 sessions
**Priority**: Low

- Custom form field registration API
- Plugin system for field components
- Theme customization examples
- Field component documentation

### 9. SWR Request Deduplication

**Estimated**: 1 session
**Priority**: Low-Medium
**Plan**: [.claude/future-tasks/swr.md](../.claude/future-tasks/swr.md)

**Issue**: On initial `/edit` page load, we see 15+ API requests when there should be 3 (one per endpoint). Caused by React Strict Mode, multiple independent hooks with separate useEffects, and no request deduplication.

**Solution**: Add SWR (~4KB) for automatic request deduplication, caching, and Strict Mode compatibility.

### 10. Performance & Caching

**Estimated**: 2 sessions
**Priority**: TBD (measure first)

- Performance profiling
- Identify bottlenecks
- Add caching layer if needed (Valkey/Redis)
- Only implement after measuring real bottlenecks

### 11. Documentation Cleanup

**Estimated**: 1 session
**Priority**: Low

- Add JSDoc comments for critical interfaces
- Create developer guide for extending CanopyCMS
- Document common patterns and conventions
- Update example apps with best practices

---

## Related

- **[AGENTS.md](../../AGENTS.md)** - Project context and working agreements
- **[apps/example1/AGENTS.md](../../apps/example1/AGENTS.md)** - Example app integration guidelines
- **[.claude/future-tasks/](../future-tasks/)** - Individual future-task specs

---

## Key Files Reference

### Auth & Authorization

- [packages/canopycms/src/auth/plugin.ts](../../packages/canopycms/src/auth/plugin.ts) - AuthPlugin interface
- [packages/canopycms-auth-clerk/src/clerk-plugin.ts](../../packages/canopycms-auth-clerk/src/clerk-plugin.ts) - Clerk auth plugin (separate package)
- [packages/canopycms/src/authorization/](../../packages/canopycms/src/authorization/) - Unified access control module
  - `groups/schema.ts`, `groups/loader.ts` - Group management
  - `permissions/schema.ts`, `permissions/loader.ts` - Permission management
  - `branch.ts`, `path.ts`, `content.ts` - Access control checks
  - `helpers.ts` - isAdmin, isReviewer helpers

### HTTP & Framework Adapters

- [packages/canopycms/src/http/](../../packages/canopycms/src/http/) - Core request/response types, router, handler
- [packages/canopycms-next/src/adapter.ts](../../packages/canopycms-next/src/adapter.ts) - Next.js adapter

---

## Success Metrics

**Phase 2 Progress (Schema, Assets & AI)** - 65% COMPLETE:

- ✅ Relational data improvements (90% done)
- ✅ Nested collection support (85% done)
- ✅ Entry type unification (complete)
- ✅ AI-ready content generation (v1 complete)
- ⏳ Entry sorting within collections (DEFERRED)
- ✅ Asset store foundation (40% done)
- 🔲 S3 asset adapter (CURRENT PRIORITY)
- 🔲 Media manager UI (CURRENT PRIORITY)

**Phase 3 (Polish & Sync)** - NOT STARTED:

- ✅ Sync and conflict detection backend (worker rebase + metadata)
- 🔲 Sync and conflict UI
- 🔲 Editor UX polished with all planned features
- 🔲 Query parameter validation

**Production Ready** - FUTURE:

- 🔲 All core features complete and documented
- 🔲 Security audit passed
- 🔲 Performance benchmarks met
- 🔲 Multi-framework support available
