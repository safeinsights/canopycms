# CanopyCMS Overall Plan

**Created**: 2024-12-21
**Last Updated**: 2026-01-08
**Status**: Active
**Current Phase**: Asset Adapters (Phase 2)

---

## Overview

CanopyCMS is a schema-driven, branch-aware CMS for GitHub-backed content. The system is feature-rich with most core functionality complete. This master plan tracks the remaining work to reach production readiness.

---

## Current Status Summary

### ✅ Completed Features

**Core Architecture**:

- Schema DSL with Zod validation (collections, singletons, nested objects, blocks)
- Git-backed content store with branch-aware workspaces
- Branch modes: `local-simple`, `local-prod-sim`, `prod`
- Content formats: JSON, Markdown, MDX with frontmatter
- Framework-agnostic HTTP layer (`canopycms/http`) with generic request/response types
- Next.js adapter in separate `canopycms-next` package
- Auth plugins use generic `CanopyRequest` interface (Clerk uses `@clerk/backend`)

**Editor UI**:

- React-based editor with Mantine components
- Split-pane layout with live preview
- Form renderer with field validation
- Entry navigator and branch manager
- Draft persistence in localStorage
- Comment system (field/entry/branch level) with thread resolution
- 657/661 tests passing (98.9%)

**GitHub PR Workflow** (Complete):

- PR creation, withdraw, request changes, merge flows
- Branch submission with auto-commit
- Review workflow with status tracking
- Post-merge cleanup and archiving

**Auth & Permissions System** (Complete):

- ✅ Groups-only permission model (replaced role-based system)
- ✅ Reserved groups: `Admins` (full access), `Reviewers` (review capabilities)
- ✅ Bootstrap admin support via `CANOPY_BOOTSTRAP_ADMIN_IDS` env var
- ✅ Auth plugin interface (Clerk implementation in separate package)
- ✅ Group management system (internal + external groups)
- ✅ Permission management system (path-based permissions)
- ✅ GroupManager and PermissionManager UI components
- ✅ All API endpoints registered and working
- ✅ Branch creation/deletion/access modification permissions
- ✅ Asset upload (Admins/Reviewers) and delete (Admins only) permissions
- ✅ Safety rules: last admin protection, reserved group protection
- ✅ Client-side permission-aware UI (BranchManager buttons disabled with tooltips)
- ✅ 497 tests passing

**API Modernization** (Complete):

- ✅ `defineEndpoint()` function with type-safe route definitions
- ✅ Migrated all 12 API modules to use `defineEndpoint()`
- ✅ Integrated ROUTE_REGISTRY for code generation
- ✅ Implemented Zod validation for params and body
- ✅ Generated type-safe client from route definitions
- ✅ 602 tests passing (+105 tests from auth phase)

---

## Prioritized Backlog

### 1. Schema Updates & Utilities

**Estimated**: 2-3 sessions (mostly complete)
**Status**: 75% COMPLETE (updated 2026-01-08)

**Completed** ✅:

1. ✅ **Relational Data** (90% complete):
   - Reference validation system ([reference-validator.ts](../../packages/canopycms/src/validation/reference-validator.ts))
   - Reference resolution utilities ([reference-resolver.ts](../../packages/canopycms/src/reference-resolver.ts))
   - API endpoints: `POST /:branch/resolve-references` and `GET /:branch/reference-options`
   - Live preview integration with two-phase resolution (synchronous + background caching)
   - Content store integration with automatic reference resolution
   - Form renderer with reference field support

2. ✅ **Nested Collections Support** (85% complete):
   - Schema types support arbitrary nesting depth (`children?: SchemaItemConfig[]`)
   - Recursive schema resolution with `parentPath` tracking
   - API support for recursive listing (`recursive?: boolean` parameter)
   - `listCollectionEntriesRecursive()` function
   - EntryNavigator UI with full nested hierarchy display using Mantine Tree component
   - Content store path resolution for nested structures

3. ⚠️ **Singleton Route Clarification** (80% complete):
   - Schema distinguishes `type: 'entry'` (singleton) vs `type: 'collection'`
   - API handles both entry type patterns
   - Content store properly handles entry types (no slug required)
   - ⚠️ **CLEANUP NEEDED**: Remove/clarify "standalone" terminology (appears in API, likely legacy)

4. **Entry sorting/reordering within collections**
   - Manual drag-and-drop reordering UI
   - Sort by field values (date, title, etc.)
   - Collection metadata for entry order storage
   - API support for updating order
   - UI integration in EntryNavigator

**Files modified**:

- New: [reference-resolver.ts](../../packages/canopycms/src/reference-resolver.ts)
- New: [validation/reference-validator.ts](../../packages/canopycms/src/validation/reference-validator.ts)
- New: [api/reference-options.ts](../../packages/canopycms/src/api/reference-options.ts)
- Updated: [config.ts](../../packages/canopycms/src/config.ts) - Nested collections support
- Updated: [api/entries.ts](../../packages/canopycms/src/api/entries.ts) - Recursive listing
- Updated: [editor/EntryNavigator.tsx](../../packages/canopycms/src/editor/EntryNavigator.tsx) - Tree UI
- Updated: [editor/FormRenderer.tsx](../../packages/canopycms/src/editor/FormRenderer.tsx) - Reference resolution

### 2. Asset Adapters

**Estimated**: 2-3 sessions
**Status**: 40% COMPLETE (updated 2026-01-08) - **CURRENT PRIORITY**

⚠️ **CAVEAT**: The initial asset infrastructure was implemented long ago and needs careful review before extending. Verify assumptions and test thoroughly.

**Completed** ✅:

- ✅ Asset store interface and LocalAssetStore implementation
- ✅ All API endpoints (list, upload, delete) with permission gating
- ✅ Permission-aware uploads (Reviewers+) and deletes (Admins only)
- ✅ Public URL building with configurable base paths
- ✅ Config schema for local, S3, LFS, and custom adapters

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

**Files to create/modify**:

- New: [asset-store-s3.ts](../../packages/canopycms/src/asset-store-s3.ts) - S3 implementation
- New: [asset-store-lfs.ts](../../packages/canopycms/src/asset-store-lfs.ts) - LFS implementation
- New: [editor/MediaManager.tsx](../../packages/canopycms/src/editor/MediaManager.tsx) - UI component
- Update: [editor/FormRenderer.tsx](../../packages/canopycms/src/editor/FormRenderer.tsx) - Add image field case

### 3. Sync & Conflict Handling

**Estimated**: 3-4 sessions
**Status**: Design needed

**Scope**:

- Background sync from main branch
- Rebase strategy with conflict detection
- UI for displaying conflicts to users
- Merge fallback when rebase fails
- Conflict resolution workflow

### 4. Query Parameter Validation

**Estimated**: 0.5 sessions
**Status**: Low priority

**Implementation**:

- Extend `defineEndpoint()` to support `query` field with Zod schema
- Update validation logic in `handler.ts` to validate query params
- Migrate routes currently using manual query validation:
  - `permissions.ts`: `searchUsers` endpoint (q parameter)
  - `assets.ts`: `listAssets` endpoint (prefix parameter)
  - `assets.ts`: `deleteAsset` endpoint (key parameter)
  - `assets.ts`: `getAssetUrl` endpoint (key parameter)

**Files to modify**:

- [packages/canopycms/src/api/route-builder.ts](../../packages/canopycms/src/api/route-builder.ts) - Add query schema support
- [packages/canopycms/src/http/handler.ts](../../packages/canopycms/src/http/handler.ts) - Validate query params
- [packages/canopycms/src/api/permissions.ts](../../packages/canopycms/src/api/permissions.ts) - Use Zod for searchUsers query validation
- [packages/canopycms/src/api/assets.ts](../../packages/canopycms/src/api/assets.ts) - Use Zod for asset query validation

### 4.5. Code Cleanup & Framework Abstraction

1. **Navigation & ToC Generation**:
   - Table of contents generation from schema
   - Navigation tree builders for static sites

2. **Documentation**:
   - Reference field API documentation
   - Singleton vs collection route patterns
   - Nested collection examples and best practices

3. **Cleanup Tasks**:
   - Remove or clarify "standalone" terminology (likely legacy naming)
   - Ensure consistent use of "entry" type for singletons throughout codebase

### 5. Code Cleanup & Framework Abstraction

**Estimated**: 1-2 sessions
**Status**: Ongoing

**Completed** ✅:

- ✅ Abstract framework-specific code (Next.js) into adapters
- ✅ Abstract auth provider code (Clerk) into plugin system
- ✅ Make core CanopyCMS framework-agnostic
- ✅ Auth plugin system is fully pluggable

**Remaining**:

- DRY up repetitive code in editor components
- Extract reusable Mantine components to shared library
- Library evaluation (replace custom code with external libs where beneficial)
- Document adapter API for other frameworks (Astro, SvelteKit, Remix)
- Create example adapter implementation for reference

### 6. Observability & Safety

**Estimated**: 1-2 sessions
**Priority**: Medium-High

**Scope**:

- Structured logging for git operations
- Performance monitoring and metrics
- Feature flags system
- Timeouts for long-running tasks
- Security audit (OWASP Top 10 review)

### 7. Editor Polish

**Estimated**: 2-3 sessions
**Priority**: Low-Medium

**Scope**:

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

**Scope**:

- Custom form field registration API
- Plugin system for field components
- Theme customization examples
- Field component documentation

### 9. SWR Request Deduplication

**Estimated**: 1 session
**Priority**: Low-Medium
**Plan**: [.claude/plans/swr.md](.claude/plans/swr.md)

**Issue**: On initial `/edit` page load, we see 15+ API requests when there should be 3 (one per endpoint). Caused by React Strict Mode, multiple independent hooks with separate useEffects, and no request deduplication.

**Solution**: Add SWR (~4KB) for automatic request deduplication, caching, and Strict Mode compatibility.

**Impact**: Doesn't break functionality, just adds latency. Fix improves perceived performance.

### 10. Performance & Caching

**Estimated**: 2 sessions
**Priority**: TBD (measure first)

**Approach**:

- Performance profiling
- Identify bottlenecks
- Add caching layer if needed (Valkey/Redis)
- Only implement after measuring real bottlenecks

### 11. Documentation Cleanup

**Estimated**: 1 session
**Priority**: Low

**Scope**:

- Add JSDoc comments for critical interfaces
- Create developer guide for extending CanopyCMS
- Document common patterns and conventions
- Update example apps with best practices

---

## Deferred Work

### Comment System Additional Testing

**Status**: 98.3% test coverage (4 skipped tests due to jsdom/Mantine Button async issues)

The following are deferred as the core functionality works correctly:

- Integration tests for full comment flow
- Edge case testing (single thread, many threads, nested fields)
- Entry/branch comment component tests
- UI polish (loading states, optimistic updates)
- Investigation of skipped async button tests

**Decision**: Revisit if issues arise in production or when higher priorities complete.

---

## Related Plans

This master plan references the following sub-plans:

1. **[.claude/plans/auth-integration.md](.claude/plans/auth-integration.md)** - Detailed implementation plan for auth integration (COMPLETED)

2. **[MIGRATION_PLAN.md](../MIGRATION_PLAN.md)** - API modernization refactor with defineEndpoint() (COMPLETED)

3. **[PROMPT.md](../PROMPT.md)** - Canonical prompt defining project goals and working agreements

4. **[packages/canopycms/examples/one/AGENTS.md](../packages/canopycms/examples/one/AGENTS.md)** - Day-to-day working agreements for the example app

---

## Key Files Reference

### Auth System Files

**Core**:

- [packages/canopycms/src/auth/plugin.ts](../../packages/canopycms/src/auth/plugin.ts) - AuthPlugin interface
- [packages/canopycms/src/auth/providers/clerk.ts](../../packages/canopycms/src/auth/providers/clerk.ts) - Clerk implementation
- [packages/canopycms/src/auth/types.ts](../../packages/canopycms/src/auth/types.ts) - Auth type definitions

**Groups**:

- [packages/canopycms/src/groups-file.ts](../../packages/canopycms/src/groups-file.ts) - Schema definition
- [packages/canopycms/src/groups-loader.ts](../../packages/canopycms/src/groups-loader.ts) - Load/save functions
- [packages/canopycms/src/api/groups.ts](../../packages/canopycms/src/api/groups.ts) - API endpoints
- [packages/canopycms/src/editor/GroupManager.tsx](../../packages/canopycms/src/editor/GroupManager.tsx) - UI component

**Permissions**:

- [packages/canopycms/src/permissions-file.ts](../../packages/canopycms/src/permissions-file.ts) - Schema definition
- [packages/canopycms/src/permissions-loader.ts](../../packages/canopycms/src/permissions-loader.ts) - Load/save functions
- [packages/canopycms/src/api/permissions.ts](../../packages/canopycms/src/api/permissions.ts) - API endpoints
- [packages/canopycms/src/editor/PermissionManager.tsx](../../packages/canopycms/src/editor/PermissionManager.tsx) - UI component

**HTTP & Framework Adapters**:

- [packages/canopycms/src/http/types.ts](../../packages/canopycms/src/http/types.ts) - CanopyRequest/Response interfaces
- [packages/canopycms/src/http/router.ts](../../packages/canopycms/src/http/router.ts) - Route matching
- [packages/canopycms/src/http/handler.ts](../../packages/canopycms/src/http/handler.ts) - Core request handler
- [packages/canopycms-next/src/adapter.ts](../../packages/canopycms-next/src/adapter.ts) - Next.js adapter
- [packages/canopycms-auth-clerk/src/clerk-plugin.ts](../../packages/canopycms-auth-clerk/src/clerk-plugin.ts) - Clerk auth (uses @clerk/backend)

**Editor Integration**:

- [packages/canopycms/src/editor/Editor.tsx](../../packages/canopycms/src/editor/Editor.tsx) - Main editor component

### GitHub PR Workflow Files (Complete)

- [packages/canopycms/src/github-service.ts](../../packages/canopycms/src/github-service.ts) - GitHub API abstraction
- [packages/canopycms/src/api/branch-status.ts](../../packages/canopycms/src/api/branch-status.ts) - Submit with PR creation
- [packages/canopycms/src/api/branch-withdraw.ts](../../packages/canopycms/src/api/branch-withdraw.ts) - Withdrawal handler
- [packages/canopycms/src/api/branch-review.ts](../../packages/canopycms/src/api/branch-review.ts) - Request changes
- [packages/canopycms/src/api/branch-merge.ts](../../packages/canopycms/src/api/branch-merge.ts) - Post-merge cleanup
- [packages/canopycms/src/editor/BranchManager.tsx](../../packages/canopycms/src/editor/BranchManager.tsx) - UI with PR status

### Comment System Files (Complete)

- [packages/canopycms/src/comment-store.ts](../../packages/canopycms/src/comment-store.ts) - Data model
- [packages/canopycms/src/api/comments.ts](../../packages/canopycms/src/api/comments.ts) - API handlers
- [packages/canopycms/src/editor/comments/InlineCommentThread.tsx](../../packages/canopycms/src/editor/comments/InlineCommentThread.tsx) - Thread display
- [packages/canopycms/src/editor/comments/ThreadCarousel.tsx](../../packages/canopycms/src/editor/comments/ThreadCarousel.tsx) - Carousel navigation

---

## Navigation for Future Agents

When working on this project:

1. **Start here**: Read this master plan for overall project status
2. **Check active work**: Review the linked sub-plan for the current priority
3. **Understand context**: Read PROMPT.md for canonical requirements
4. **Review domain**: Check the specific plan file for the feature area
5. **Check working agreements**: See AGENTS.md files for day-to-day conventions

All plans are stored in `.claude/plans/` within the workspace to keep them versioned with the code.

---

## Success Metrics

**Phase 1 Complete (Auth)** - ✅ DONE (Dec 2024):

- ✅ Groups-only permission model (admin/manager/editor roles removed)
- ✅ Reserved groups system (Admins, Reviewers)
- ✅ Bootstrap admin support for initial setup
- ✅ All branch/asset/path permission checks working
- ✅ 497 tests passing

**Phase 1.5 Complete (API Modernization)** - ✅ DONE (Jan 2026):

- ✅ defineEndpoint() pattern implemented across all API modules
- ✅ All 12 API modules migrated to declarative route definitions
- ✅ Type-safe code generation with ROUTE_REGISTRY
- ✅ Zod validation for params and body
- ✅ 602 tests passing (+105 tests, 98.3% coverage)

**Phase 2 Progress (Schema & Assets)** - 60% COMPLETE:

- ✅ Relational data improvements (90% done - Priority 1)
- ✅ Nested collection support (85% done - Priority 1)
- ⚠️ Singleton route clarification (80% done - needs cleanup - Priority 1)
- ⏳ Schema utilities for SSG (ToC/navigation - DEFERRED to Priority 5+)
- ⏳ **NEW: Entry sorting within collections (DEFERRED to Priority 5+)**
- ✅ Asset store foundation (40% done - Priority 2)
- 🔲 S3 asset adapter (CURRENT PRIORITY - Priority 2)
- 🔲 Media manager UI (CURRENT PRIORITY - Priority 2)

**Phase 3 Complete (Polish & Sync)** - NOT STARTED:

- 🔲 Sync and conflict detection working (Priority 3)
- 🔲 Editor UX polished with all planned features (Priority 7)
- 🔲 Query parameter validation (Priority 4)
- 🔲 Comprehensive test coverage maintained (>95%)

**Production Ready** - FUTURE:

- 🔲 All core features complete and documented
- 🔲 Security audit passed (Priority 6)
- 🔲 Performance benchmarks met (Priority 10)
- 🔲 Example apps demonstrate all capabilities
- 🔲 Multi-framework support available (Priority 5)
