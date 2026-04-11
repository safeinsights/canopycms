---
name: baseline-review
description: Comprehensive baseline review of the entire CanopyCMS codebase
effort: max
model: opus[1m]
---

Do a comprehensive baseline review of the entire CanopyCMS codebase. This codebase was largely vibecoded, so focus on finding real issues: production bugs, security vulnerabilities, architectural inconsistencies, client/server boundary violations, and incorrect behavior. Do NOT nitpick style, formatting, or missing comments.

## Approach

Run the following review phases. Use parallel agents wherever possible to maximize throughput. Use the specified model for each agent to balance reasoning depth vs speed.

### Phase 1: Automated checks (parallel, all haiku)

Run all three of these in parallel using haiku-level agents:

1. **Typecheck**: Run `pnpm typecheck` across the monorepo. Collect all type errors.
2. **Lint**: Run `pnpm lint` across the monorepo. Collect all lint errors/warnings.
3. **Tests**: Run `pnpm test` (vitest). Report any failures or skipped tests beyond the 5 known Mantine Button jsdom skips.

### Phase 2: Domain reviews (parallel)

Launch parallel review agents for each domain below. Each agent should report issues classified as:

- **Critical** — would break in production, cause data loss, or create a security vulnerability
- **High** — incorrect behavior that would surface under normal use
- **Medium** — inconsistency or missing guard that could cause issues under edge cases
- **Low** — code quality issue worth noting but not urgent

For each issue, include: severity, file path with line number, description, and suggested fix.

#### Agent 1: Security & Authorization (model: opus)

Review: `src/authorization/`, `src/auth/`, `src/api/guards.ts`, `src/middleware/`, and all API handlers in `src/api/`.
Check for:

- Auth checks missing on any API endpoint
- Path traversal vulnerabilities (user input reaching filesystem without validation)
- Branch access control bypasses
- Secrets or credentials in code
- CSRF/injection vectors
- Ensure `checkContentAccess()` is called consistently before any content read/write
- Verify JWT/session validation on all authenticated routes

#### Agent 2: Client/Server Boundary (model: sonnet)

Use grep-first approach — do NOT read every editor file. Instead:

1. Search for imports of `node:fs`, `node:path`, `node:child_process`, `node:os`, `node:crypto` in `src/editor/` and `src/client.ts`
2. Search for missing `'use client'` directives: find React components in `src/editor/` that use hooks (useState, useEffect, etc.) but lack the directive
3. Read `src/index.ts`, `src/client.ts`, `src/server.ts`, and the exports map in `package.json` to verify the public API surface is clean
4. For any grep hits, read those specific files to assess severity

#### Agent 3: Content Store & Git Operations (model: opus)

Read all of: `src/content-store.ts`, `src/git-manager.ts`, `src/github-service.ts`, `src/branch-workspace.ts`, `src/branch-registry.ts`, `src/branch-metadata.ts`, `src/content-id-index.ts`, `src/asset-store.ts`.
Check for:

- Race conditions in concurrent file access (multiple editors on same branch)
- Atomic write correctness (partial writes that could corrupt content)
- Git command injection via user-supplied branch names or paths
- Missing error handling on git operations (push failures, merge conflicts)
- Content ID index consistency (stale cache, concurrent writes)
- Branch workspace cleanup failures
- File locking correctness

#### Agent 4: API Layer Consistency (model: sonnet)

Read all files in `src/api/`, `src/http/`, `src/context.ts`, `src/services.ts`.
Check for:

- Inconsistent error response formats across endpoints
- Missing input validation (Zod schemas not applied, unvalidated params)
- Endpoints that bypass the guard system
- Inconsistent use of ApiContext vs direct service access
- Missing or incorrect HTTP status codes
- Request handler patterns that don't match the established conventions in `src/api/AGENTS.md`

#### Agent 5: Schema, Validation & Config (model: sonnet)

Read all files in `src/schema/`, `src/validation/`, `src/config/`, plus `src/config.ts`, `src/entry-schema.ts`, `src/entry-schema-registry.ts`, `src/reference-resolver.ts`.
Check for:

- Schema validation gaps (fields that aren't validated at runtime)
- Config validation that could accept invalid state
- Reference resolution edge cases (circular refs, missing targets, cross-branch refs)
- Field traversal missing field types
- Zod schemas that don't match TypeScript types

#### Agent 6: Operating Modes & Deployment (model: sonnet)

Read all files in `src/operating-mode/`, `src/worker/`, `src/build/`, `src/cli/`, plus `src/build-mode.ts`.
Check for:

- Code that only works in dev mode but breaks in prod (or vice versa)
- Lambda constraints violated (internet access assumed, large temp files, long timeouts)
- Worker process error handling and recovery
- CLI commands with incorrect error handling
- Static build producing incorrect output
- EFS-specific filesystem assumptions that break locally

#### Agent 7: Editor UI & UX (model: opus)

Read all 127 files in `src/editor/` (components, hooks, forms, preview bridge, block editor).
Check for:

- React state/effect correctness (stale closures, missing dependency arrays, race conditions in async effects)
- Schema-driven form fields actually enforcing validation before save
- Preview bridge correctness (draft updates, click-to-focus/highlight)
- Block editor drag-and-drop edge cases (reorder, add, remove)
- Error UX: what happens when API calls fail — useful error or silent failure?
- Keyboard navigation and accessibility (ARIA attributes on interactive elements)
- Mantine component usage correctness, no style leakage into host app CSS

### Phase 3: Cross-cutting analysis

After all Phase 2 agents complete, run two things in parallel:

#### Agent 8: Codebase hygiene (model: opus)

Scan the full `packages/canopycms/src/` codebase:

1. **Dead code**: Find exported functions/types with zero importers (grep for the export name across the codebase)
2. **Test coverage gaps**: Compare source files against test files — flag any non-trivial module with no corresponding test
3. **Dependency concerns**: Review `package.json` for outdated/vulnerable deps, unnecessary deps, or deps that duplicate functionality
4. **Pattern consistency**: Find places where error handling, path validation, or auth patterns deviate from the conventions in `DEVELOPING.md`

#### Main Claude: Triangulation & credibility check

You (the main Claude, not a subagent) must do two things with the Phase 2 results before writing the report:

1. **Cross-reference for compounding issues**: Look for findings from different agents that touch the same code path or interact in ways that compound severity. For example:
   - Agent 1 flags missing auth + Agent 4 flags missing input validation on the same endpoint → escalate to Critical
   - Agent 3 flags a race condition in content-store + Agent 7 flags async effects in the editor that trigger the same path → combination may be worse than either alone
   - Agent 5 flags a schema validation gap + Agent 1 flags the same field reaches the filesystem → potential path traversal

   Identify these as explicit "compound findings" in the report.

2. **Spot-check dubious findings**: Before any Critical or High finding goes into the final report:
   - Verify the file and line number exist
   - Read the actual code to confirm the issue is real
   - Downgrade or discard findings that don't hold up

### Phase 4: Report

Produce a single consolidated report with:

1. **Executive summary**: Overall assessment of codebase health (1-2 paragraphs)
2. **Compound findings**: Issues identified by cross-referencing multiple agents (highest priority)
3. **Critical/High findings**: Verified numbered list, each with file:line, description, and fix
4. **Medium findings**: Grouped by domain
5. **Low findings**: Grouped by domain
6. **Architectural observations**: Any systemic patterns that should be addressed
7. **Positive observations**: Things the codebase does well (important for calibration)

Write this report to `REVIEW-REPORT.md` in the project root.
