# CanopyCMS Overall Plan

**Created**: 2024-12-21
**Status**: Active
**Current Phase**: Auth Integration Completion

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
- Service factory and Next.js adapter

**Editor UI**:
- React-based editor with Mantine components
- Split-pane layout with live preview
- Form renderer with field validation
- Entry navigator and branch manager
- Draft persistence in localStorage
- Comment system (field/entry/branch level) with thread resolution
- 232/236 tests passing (98.3%)

**GitHub PR Workflow** (Complete):
- PR creation, withdraw, request changes, merge flows
- Branch submission with auto-commit
- Review workflow with status tracking
- Post-merge cleanup and archiving

**Auth System** (80% Complete):
- ✅ Auth plugin interface defined ([src/auth/plugin.ts](../../packages/canopycms/src/auth/plugin.ts))
- ✅ Clerk auth plugin implemented ([src/auth/providers/clerk.ts](../../packages/canopycms/src/auth/providers/clerk.ts)) with 35+ tests
- ✅ Group management system (internal + external groups)
- ✅ Permission management system (path-based permissions)
- ✅ GroupManager UI component with Storybook stories
- ✅ PermissionManager UI component
- ✅ API endpoints for groups and permissions
- ❌ **Missing**: API routes not registered in route handler
- ❌ **Missing**: Editor UI handlers still use console.log placeholders
- ❌ **Missing**: Example app not configured with Clerk

---

## Active Work: Auth Provider Refactoring (BLOCKING)

**Priority**: 🚨 **#1 - BLOCKING CURRENT WORK**
**Plan File**: [.claude/plans/auth-provider-refactor.md](.claude/plans/auth-provider-refactor.md)
**Estimated Effort**: 4-6 hours

**BLOCKING ISSUE**: npm workspace hoisting is preventing `@clerk/nextjs` from being resolved in the example app. This blocks the completion of auth integration.

**Solution**: Move Clerk implementation to separate `canopycms-auth-clerk` package.

See [.claude/plans/auth-provider-refactor.md](.claude/plans/auth-provider-refactor.md) for detailed implementation steps.

**After this is complete**, continue with auth integration: [.claude/plans/auth-integration.md](.claude/plans/auth-integration.md)

---

## Prioritized Backlog

### 1. Code Cleanup & Framework Abstraction
**Estimated**: 3-4 sessions
**Priority**: High (after auth completion)

**Goals**:
- Abstract framework-specific code (Next.js) into adapters
- Abstract auth provider code (Clerk) into plugin system
- Make core CanopyCMS framework-agnostic
- DRY up repetitive code
- Extract reusable Mantine components
- Library evaluation (replace custom code with external libs)
- Improve developer experience for future Claude sessions

**Key Changes**:
- Move Next.js-specific logic to `/src/next/` adapter
- Document adapter API for other frameworks (Astro, SvelteKit, Remix)
- Ensure auth plugin system is fully pluggable (Clerk is just one implementation)
- Create framework adapter examples
- Add JSDoc comments for critical interfaces
- Simplify file organization for easier navigation
- Create developer guide for extending CanopyCMS

### 2. Observability & Safety
**Estimated**: 1-2 sessions
**Priority**: Medium-High

- Structured logging for git operations
- Performance monitoring
- Feature flags
- Timeouts for long-running tasks
- Security audit (OWASP Top 10)

### 3. Schema Updates & Utilities
**Estimated**: 1-2 sessions
**Priority**: Medium

- Utilities for table of contents generation
- Navigation tree builders from schema ordering
- Better support for relational data (author references, etc.)

### 4. Asset Adapters
**Estimated**: 2-3 sessions
**Priority**: Medium

- S3 adapter with presigned uploads
- Git LFS adapter surface
- Media manager UI with browsing/search
- Permission-aware uploads
- Public URL building

### 5. Sync & Conflict Handling
**Estimated**: 3-4 sessions
**Priority**: Medium

- Background sync from main branch
- Rebase strategy with conflict detection
- UI for displaying conflicts
- Merge fallback when rebase fails

### 6. Editor Polish
**Estimated**: 2-3 sessions
**Priority**: Low-Medium

- Navigator search/add/delete
- Mermaid diagram support
- Monaco code editor integration
- MDX editor enhancements
- Keyboard shortcuts
- Collection/status filtering
- Type-smoke tests for API shape verification

### 7. Customizability
**Estimated**: 2 sessions
**Priority**: Low

- Custom form field registration
- Plugin system for field components
- Theme customization examples

### 8. Performance & Caching
**Estimated**: 2 sessions
**Priority**: TBD (measure first)

- Performance profiling
- Identify bottlenecks
- Add caching layer if needed (Valkey/Redis)

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

1. **[.claude/plans/auth-integration.md](.claude/plans/auth-integration.md)** - Detailed implementation plan for completing auth integration (CURRENT FOCUS)

2. **[PROMPT.md](../PROMPT.md)** - Canonical prompt defining project goals and working agreements

3. **[packages/canopycms/examples/one/AGENTS.md](../packages/canopycms/examples/one/AGENTS.md)** - Day-to-day working agreements for the example app

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

**Integration**:
- [packages/canopycms/src/next/api.ts](../../packages/canopycms/src/next/api.ts) - Next.js route adapter
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

**Phase 1 Complete (Auth)** - CURRENT TARGET:
- ✅ Auth system fully functional end-to-end
- ✅ Example app demonstrates Clerk integration
- ✅ GroupManager and PermissionManager working with real data
- ✅ All tests passing

**Phase 2 Complete (Schema & Assets)**:
- ✅ Schema utilities for static site generation
- ✅ S3 asset adapter working
- ✅ Media manager UI functional

**Phase 3 Complete (Polish & Sync)**:
- ✅ Editor UX polished with all planned features
- ✅ Sync and conflict detection working
- ✅ Comprehensive test coverage (>95%)

**Production Ready**:
- ✅ All core features complete and documented
- ✅ Security audit passed
- ✅ Performance benchmarks met
- ✅ Example apps demonstrate all capabilities
- ✅ Multi-framework support available
