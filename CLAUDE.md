# CanopyCMS — Claude Instructions

## Behavioral Rules (always apply)

- Never git add or git commit without being asked. Always provide a commit message when finishing work.
- Propose next work at the end of each iteration.
- Use `npm`/`npx`, NOT bun.
- Use extensionless local imports.
- Avoid `any` — use real types, and if we can't, use `unknown` with type guards.
- Use `getErrorMessage()` / `isNodeError()` from `utils/error.ts`.
- This is new code — no legacy compat needed, no migrations.
- Keep as much code in the package as possible; avoid new package entrypoints without approval.
- Don't add new touchpoints between example app and CanopyCMS without approval.
- Use popular open source libraries instead of writing new code if good options are available.

## Do NOT

- Don't use `rg` or `apply_patch` — use Claude's built-in Grep and Edit tools instead.
- Don't introduce `any` types, command injection, XSS, or path traversal vulnerabilities.
- Don't mix Mantine (editor) styling into the host app or example app styling.
- Don't add server-only deps (node:fs, etc.) to client/browser bundles.

## Before Providing a Commit Message

Before writing the commit message at the end of a task, check whether docs need updating:

- **New/changed modules or APIs?** → Run the `update-codebase-guide` agent; update the Code Organization list in AGENTS.md.
- **Architectural changes, new packages, or design decisions?** → Run the `docs-architecture` agent.
- **New dev patterns, test utilities, or workflows?** → Run the `docs-developing` agent.
- **Feature changes visible to adopters?** → Run the `docs-readme` agent.

## Project Context

@AGENTS.md
