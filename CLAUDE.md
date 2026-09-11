# CanopyCMS — Claude Instructions

## Behavioral Rules (always apply)

- Commit and push without asking when the task clearly implies landing changes (PR fix loops, "fix and reply" requests, explicit feature work) — non-main branches only, and always report what was committed. Ask first before anything touching main, force-pushes, or history rewrites. When work ends uncommitted, provide a commit message.
- Any out-of-scope issue flagged mid-session (background-task chip, review aside, agent finding, deferred fix) must be captured as a `.claude/future-tasks/` file plus an `index.md` row before the session ends — session suggestions are ephemeral; the files are the durable backlog. When a task is completed, move its file to `.claude/future-tasks/resolved/` (updating inbound links) and move its index row to the Resolved section.
- Propose next work at the end of each iteration.
- Use `pnpm`/`pnpm exec`, NOT npm or bun.
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

1. Run `pnpm exec prettier --write` on any files you created or modified.
2. Run `pnpm lint` and fix any errors before finishing. If you touched `packages/canopycms/src/` or `packages/canopycms-next/src/`, also run `pnpm lint:bundle` (client-bundle boundary).
3. Run the `update-codebase-guide` agent and update the Code Organization list in AGENTS.md if you added, removed, renamed, or changed the API of any module.
4. Run the `docs-architecture` agent if you made architectural changes, added packages, or made design decisions.
5. Run the `docs-developing` agent if you introduced new dev patterns, test utilities, or workflows.
6. Run the `docs-readme` agent if you made feature changes visible to adopters.
7. **Report the net line delta of any doc you touched.** Steps 3-6 only ever added: between
   2026-07-21 and 2026-08-22 the four root docs grew by 2,154 lines and not one ever shrank,
   and AGENTS.md's word count tripled while its line count never moved. If a doc grew, say by
   how much and why; if something is now superseded, delete it in the same pass.

## Which doc do I read for X?

Only `AGENTS.md` is loaded automatically (below). Everything else you have to go and get:

| Looking for                                                | Read                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| What a module does, and where its invariants live          | that module's own `AGENTS.md` — see the table in [AGENTS.md](AGENTS.md#code-organization) |
| The precise rule governing a line of code                  | **the code comment at that line.** It is authoritative; the docs are the map to it        |
| Adopter-facing API, config, integration steps              | [README.md](README.md)                                                                    |
| System concepts, package boundaries, design decisions      | [ARCHITECTURE.md](ARCHITECTURE.md)                                                        |
| Contributor patterns, test utilities, workflows            | [DEVELOPING.md](DEVELOPING.md)                                                            |
| Which file or symbol does X                                | [CODEBASE_GUIDE.md](CODEBASE_GUIDE.md)                                                    |
| Locks, caches, anything read-modify-write on the workspace | [docs/concurrency.md](docs/concurrency.md) — **required reading before you add one**      |
| What to work on next, and known open issues                | [.claude/future-tasks/index.md](.claude/future-tasks/index.md)                            |
| Deploying to AWS                                           | [docs/deploying-to-aws.md](docs/deploying-to-aws.md)                                      |
| Findings from a past whole-codebase review                 | `docs/reviews/<YYYY-MM>.md` — dated snapshots, may cite since-moved files                 |

## Project Context

@AGENTS.md
