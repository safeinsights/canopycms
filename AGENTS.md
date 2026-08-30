# AGENTS – CanopyCMS

Purpose: CanopyCMS is a schema-driven, branch-aware CMS for a team of users to edit git-backed, statically-generated sites. It stores edited state in a file system, with permanent state pushed to git. Keep adopter effort minimal: expose config + Editor + one catch-all API route, and move logic into the package whenever possible.

## What we are building

- A TypeScript package called CanopyCMS that can be added to a statically generated website to let a team of users edit the content of that website.
- The content of the host websites is drawn from MD/MDX/JSON files in the website repo. CanopyCMS provides a way to edit those files.
- Within our package, we are building an example app called "one" that shows CanopyCMS in use. Critically, this example app should only have connections to certain public aspects of the CanopyCMS code: the Editor component, a way to set the Canopy config, and one catch-all API route that the Editor calls and which fans out to internal Canopy handlers under the covers. If we need additional touchpoints between the example app and CanopyCMS, you need to get me to approve that before you add them.

## First Supported Deployment

- We will eventually be the first user of the CanopyCMS package for our own websites.
- Production ('prod' operating mode) deployed to AWS: Lambda (no internet, via Function URL) + EC2 worker (t4g.nano spot) + EFS. No NAT Gateway. See [docs/deploying-to-aws.md](docs/deploying-to-aws.md) and [ARCHITECTURE.md](ARCHITECTURE.md#deployment-architecture) for details.

## End Goals / Requirements

- Adopters of CanopyCMS have a single repo website that contains their code + content. Adopters install CanopyCMS in that repo so non-technical users can edit without touching Git.
- Schema-defined content (collections/entry types/blocks/fields) with runtime enforcement to keep data clean; MD/MDX supported (with Mermaid/code fields), plus JSON.
- Two deploy shapes:
  - (a) public build with zero editor code + separate editor-only build; the public build can be built with calls to the editor code if helpful, but after it is built it has no use of the editor code
  - (b) public build that has the editor components included; the a public user hitting the public site doesn't cause interactions with the editor API.
    Both read/write the same repo content. The static public site is rebuilt (fully or partially) on published edit.
- External auth via Clerk (pluggable in code), with roles admin/manager/editor. AuthZ enforces branch ACLs and per-path permissions (users/groups).
- Live editing UX: schema-driven forms, custom field components, block-based page building, live preview via preview bridge (draft updates + click-to-focus/highlight).
- Branch-first workflow: every edit happens on a branch backed by a filesystem clone. Creating/choosing a branch provisions/resolves a clone (prod/dev). Editors see branch-specific content everywhere.
- Git/branch UX: UI for switching/creating branches, setting branch ACLs, saving (writes files, no commit), and submitting for merge. Users do not see raw Git commands.
- Save vs publish: “Save” writes to the branch working tree only. “Publish” commits and pushes the branch via bot, opens/updates a PR, and updates branch status. Review flow supports comments/threads (stored in branch clone), request-changes unlock, and admin visibility of diffs on GitHub. Admins can see all branches; editors only see authorized branches.
- Sync with upstream: when upstream changes (other PRs), branch clones must be updated/rebased; surface conflicts to editors without destroying local edits.
- Path-based access: admins define who can edit specific files/trees; enforced on read/write.
- Assets: pluggable adapter (local for dev; S3 required soon; LFS option). Keep assets out of Git when using cloud storage.

## Operating Modes

See [ARCHITECTURE.md](ARCHITECTURE.md#operating-modes) for detailed mode behavior. Both modes must work:

- `prod`: Branch clones on persistent filesystem (e.g., EFS)
- `dev`: Full-featured local development with branching and git ops, workspaces at `.canopy-dev/content-branches/`

## Development Guidelines

See [DEVELOPING.md](DEVELOPING.md) for detailed development patterns and practices.

## Code Organization

The core package lives in `packages/canopycms/src/`. **Each module's own `AGENTS.md`
holds its invariants, and the code comment at the point of a rule is authoritative** —
this table is only the map.

Until 2026-08-23 that detail lived here, in one bullet per directory. Those bullets grew
to ~4,000 words while the file's line count never moved, because the only cheap edit was
to append inside an existing bullet. Two consequences worth avoiding a repeat of: the
section was ~80% of the single file `CLAUDE.md` loads into every agent's context, and
depth had become inversely proportional to subsystem size — `static/` (841 LOC) had 976
words, `editor/` (20,855 LOC, 176 files) had eight.

| Module            | What it is                                                                           | Detail                                                                      |
| ----------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `api/`            | API handlers, incl. `guards.ts`'s declarative guard system                           | [api/AGENTS.md](packages/canopycms/src/api/AGENTS.md)                       |
| `assets/`         | Asset store v2, finalize pipeline, on-demand transform engine                        | [assets/AGENTS.md](packages/canopycms/src/assets/AGENTS.md)                 |
| `authorization/`  | Branch + path access control, groups, protected-base-branch policy                   | [authorization/AGENTS.md](packages/canopycms/src/authorization/AGENTS.md)   |
| `ai/`             | AI-ready content generation, transforms, route handler                               | [ai/AGENTS.md](packages/canopycms/src/ai/AGENTS.md)                         |
| `build/`          | Static build output, and pruning what prior runs produced                            | [build/AGENTS.md](packages/canopycms/src/build/AGENTS.md)                   |
| `cli/`            | `init`, `init-deploy`, `worker`, `generate-ai-content`, `sync`, `migrate`            | [cli/AGENTS.md](packages/canopycms/src/cli/AGENTS.md)                       |
| `config/`         | Configuration types, schemas, validation                                             | —                                                                           |
| `editor/`         | React editor UI: components, hooks, fields, block editor, preview bridge             | [editor/AGENTS.md](packages/canopycms/src/editor/AGENTS.md)                 |
| `operating-mode/` | prod/dev strategies; single resolution points for mode + deployment name             | [operating-mode/AGENTS.md](packages/canopycms/src/operating-mode/AGENTS.md) |
| `paths/`          | Path utilities with branded types (LogicalPath, PhysicalPath)                        | see below                                                                   |
| `schema/`         | Schema loading and resolution                                                        | —                                                                           |
| `static/`         | Static-generation helpers and the four build-time guards                             | [static/AGENTS.md](packages/canopycms/src/static/AGENTS.md)                 |
| `utils/`          | Shared utilities, several consolidating a past drift                                 | [utils/AGENTS.md](packages/canopycms/src/utils/AGENTS.md)                   |
| `validation/`     | Field traversal, reference/entry validation                                          | [validation/AGENTS.md](packages/canopycms/src/validation/AGENTS.md)         |
| `worker/`         | CmsWorker daemon, task queue, git sync/rebase loop                                   | [worker/AGENTS.md](packages/canopycms/src/worker/AGENTS.md)                 |
| flat `src/*.ts`   | content store/listing/tree, git-manager, branch registry, services, url-collision, … | [src/AGENTS.md](packages/canopycms/src/AGENTS.md)                           |

`paths/` has no file of its own but does carry one invariant: `branch-name.ts` is the
dependency-free home of `sanitizeBranchName`, and client-reachable code must import it
from there, never from `paths/branch.ts` or the `paths` barrel — both pull `node:fs` into
the browser bundle. `pnpm lint:bundle` enforces this, so it is a check rather than a
convention.

See [ARCHITECTURE.md](ARCHITECTURE.md#module-structure) for conceptual documentation, and
[docs/concurrency.md](docs/concurrency.md) before touching any cache, lock, or
read-modify-write against the workspace.

## Subdirectory Guidelines

Every core module's `AGENTS.md` is linked from the table above. Two more, outside that
table:

- [apps/example1/AGENTS.md](apps/example1/AGENTS.md) - Example app integration guidelines
- [packages/canopycms/src/editor/hooks/README.md](packages/canopycms/src/editor/hooks/README.md) - which editor data hooks are SWR-backed and which are not

**When you learn something durable about a module, write it in that module** — in the code
comment at the point of the rule first, and in the module's `AGENTS.md` if a future editor
would not encounter that comment. Do not append it here. This file is loaded into every
agent's context on every task, which is exactly why it must stay a map.

## Working Agreements

- Use TypeScript/React. Avoid destructive git commands.
- Prefer using popular, maintained libraries over bespoke code.
- Primary target is Next.js websites, but will expand to others.
- Keep the styling of the host app separate from that of the CanopyCMS editing interface. CanopyCMS uses Mantine, but host apps/examples can use whatever they want.
- Keep docs current: update `BACKLOG.md`, `README.md`, and AGENTS when behavior or workflows change.
- Always honor branch modes (prod/dev) and path traversal guards. Branch metadata/registry live under `.canopy-dev/` (dev) or the configured workspace root (prod).
- Concurrency: before adding any cache, mutable JSON file, or read-modify-write against the workspace, read [docs/concurrency.md](docs/concurrency.md) (locking layers, generation markers, EFS/NFS rules, recipes) — and keep it updated when you change that behavior.
- Expose client-only React via `canopycms/client` with `use client`; keep server-only deps out of browser bundles.

## Quality Checks

See [DEVELOPING.md](DEVELOPING.md#quality-checks) for testing and typecheck requirements. `pnpm lint:bundle` (dependency-cruiser) fails when anything reachable from `canopycms/client` reaches a node built-in — see [Client-Bundle Boundary Check](DEVELOPING.md#client-bundle-boundary-check). `pnpm lint:tasks` enforces the backlog rule below — dead links between task files, rows still listed open whose file moved to `resolved/`, and orphans in both directions — see [Future-Tasks Backlog Check](DEVELOPING.md#future-tasks-backlog-check). Claude subagents are available:

- `.claude/agents/test.md` - Run tests and fix failures
- `.claude/agents/typecheck.md` - Type checking
- `.claude/agents/review.md` - Code review checklist
- `.claude/agents/debug.md` - Debugging and issue investigation
- `.claude/agents/codebase-guide.md` - Codebase navigation and understanding

## Documentation Maintenance

After making significant changes, use these agents proactively to keep docs in sync:

- `.claude/agents/docs-architecture.md` - Update ARCHITECTURE.md after architectural changes, new packages, or design decisions
- `.claude/agents/docs-developing.md` - Update DEVELOPING.md after new dev patterns, test utilities, or contributor workflows
- `.claude/agents/docs-readme.md` - Update README.md after feature changes affecting adopters
- `.claude/agents/update-codebase-guide.md` - Update codebase-guide.md after new modules, APIs, or major refactors

## Adopter Integration Constraints

Keep adopter effort minimal: only expose config + Editor + one catch-all API route. See [README.md](README.md#adopter-touchpoints-summary) for practical integration steps.
