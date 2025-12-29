# AGENTS – CanopyCMS

Purpose: CanopyCMS is a schema-driven, branch-aware CMS for a team of users to edit git-backed, statically-generated sites. It stores edited state in a file system, with permanent state pushed to git. Keep adopter effort minimal: expose config + Editor + one catch-all API route, and move logic into the package whenever possible.

## What we are building

- A TypeScript package called CanopyCMS that can be added to a statically generated website to let a team of users edit the content of that website.
- The content of the host websites is drawn from MD/MDX/JSON files in the website repo. CanopyCMS provides a way to edit those files.
- Within our package, we are building an example app called "one" that shows CanopyCMS in use. Critically, this example app should only have connections to certain public aspects of the CanopyCMS code: the Editor component, a way to set the Canopy config, and one catch-all API route that the Editor calls and which fans out to internal Canopy handlers under the covers. If we need additional touchpoints between the example app and CanopyCMS, you need to get me to approve that before you add them.

## First Supported Deployment

- We will eventually be the first user of the CanopyCMS package for our own websites.
- For this we want to support: production ('prod' operating mode) will be deployed to AWS. Web handling will be via normal Lambda functions (no Edge, no API Gateway). There could be a worker Lambda if isn't fast enough within web request cycle. The filesystem will be EFS.

## End Goals / Requirements

- Adopters of CanopyCMS have a single repo website that contains their code + content. Adopters install CanopyCMS in that repo so non-technical users can edit without touching Git.
- Schema-defined content (collections/singletons/blocks/fields) with runtime enforcement to keep data clean; MD/MDX supported (with Mermaid/code fields), plus JSON.
- Two deploy shapes:
  - (a) public build with zero editor code + separate editor-only build; the public build can be built with calls to the editor code if helpful, but after it is built it has no use of the editor code
  - (b) public build that has the editor components included; the a public user hitting the public site doesn't cause interactions with the editor API.
    Both read/write the same repo content. The static public site is rebuilt (fully or partially) on published edit.
- External auth via Clerk (pluggable in code), with roles admin/manager/editor. AuthZ enforces branch ACLs and per-path permissions (users/groups).
- Live editing UX: schema-driven forms, custom field components, block-based page building, live preview via preview bridge (draft updates + click-to-focus/highlight).
- Branch-first workflow: every edit happens on a branch backed by a filesystem clone. Creating/choosing a branch provisions/resolves a clone (prod/local-prod-sim/local-simple). Editors see branch-specific content everywhere.
- Git/branch UX: UI for switching/creating branches, setting branch ACLs, saving (writes files, no commit), and submitting for merge. Users do not see raw Git commands.
- Save vs publish: “Save” writes to the branch working tree only. “Publish” commits and pushes the branch via bot, opens/updates a PR, and updates branch status. Review flow supports comments/threads (stored in branch clone), request-changes unlock, and admin visibility of diffs on GitHub. Admins can see all branches; editors only see authorized branches.
- Sync with upstream: when upstream changes (other PRs), branch clones must be updated/rebased; surface conflicts to editors without destroying local edits.
- Path-based access: admins define who can edit specific files/trees; enforced on read/write.
- Assets: pluggable adapter (local for dev; S3 required soon; LFS option). Keep assets out of Git when using cloud storage.

## Operating Modes

See [ARCHITECTURE.md](ARCHITECTURE.md#operating-modes) for detailed mode behavior. All three modes must work:

- `prod`: Branch clones on persistent filesystem (e.g., EFS)
- `local-prod-sim`: Simulates prod locally in `.canopycms/branches/`
- `local-simple`: Direct editing in current checkout, no cloning

## Development Guidelines

See [DEVELOPING.md](DEVELOPING.md) for detailed development patterns and practices.

## Working Agreements

- Use TypeScript/React; keep code ASCII; prefer `rg` for search and `apply_patch` for edits. Avoid destructive git commands.
- Prefer using popular, maintained libraries over bespoke code.
- Avoid `any` unless documented.
- IMPORTANT: This is new code that has not been used by others yet, so no need to maintain interfaces for legacy uses, no need for migrations.
- Primary target is Next.js websites, but will expand to others.
- Learn from `reference/` but do not edit its contents.
- Use extensionless local imports.
- Keep the styling of the host app separate from that of the CanopyCMS editing interface. CanopyCMS uses Mantine, but host apps/examples can use whatever they want.
- Keep docs current: update `BACKLOG.md`, `README.md`, and AGENTS when behavior or workflows change.
- Always honor branch modes (prod/local-prod-sim/local-simple) and path traversal guards. Branch metadata/registry live under `.canopycms/`.
- Keep as much code in the package as possible so adopters do less work; avoid new package entrypoints without intent.
- Expose client-only React via `canopycms/client` with `use client`; keep server-only deps out of browser bundles.
- Propose next work at the end of each iteration.

## Quality Checks

See [DEVELOPING.md](DEVELOPING.md#quality-checks) for testing and typecheck requirements. Claude subagents are available:

- `.claude/agents/test.md` - Run tests and fix failures
- `.claude/agents/typecheck.md` - Type checking
- `.claude/agents/review.md` - Code review checklist

## Adopter Integration Constraints

Keep adopter effort minimal: only expose config + Editor + one catch-all API route. See [README.md](README.md#adopter-integration) for practical integration steps.
