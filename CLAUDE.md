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

## When You Finish a Task

Always do the following **before** proposing next work or providing a commit message:

1. Run the `update-codebase-guide` agent and update the Code Organization list in AGENTS.md if you added, removed, renamed, or changed the API of any module.
2. Run the `docs-architecture` agent if you made architectural changes, added packages, or made design decisions.
3. Run the `docs-developing` agent if you introduced new dev patterns, test utilities, or workflows.
4. Run the `docs-readme` agent if you made feature changes visible to adopters.

## Project Context

@AGENTS.md
