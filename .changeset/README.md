# Changesets

Every PR that changes a published package adds one file here: its entry in
[CHANGELOG.md](../CHANGELOG.md), plus the version bump it needs. Nobody edits CHANGELOG.md's
`## Unreleased` by hand. Each int build ships the files assembled into
`node_modules/canopycms/CHANGELOG.md`, with each entry labelled by the first int that carried it,
and a stable release moves them under `## Released` and deletes them.

CI fails a PR, opened after its base branch adopted changesets, that changes a package, the
lockfile, `pnpm-workspace.yaml`, `tsconfig.base.json` or `scripts/add-js-extensions.mjs` without
adding or editing a file here. Tests, fixtures and `AGENTS.md` alone do not count.

## Which file to write

- **No adopter-visible effect** (a refactor, a test, an internal fix): an empty changeset,
  `pnpm exec changeset add --empty`.
- **A change an adopter can see**: an entry, below. Name the file after the change, in
  kebab-case. A name is never reused, even after its entry is released.
- **More to say about an entry that already shipped in an int**: a part, a new file with
  `extends:` in its metadata. Edit the shipped file only to correct it. A part may extend an
  unreleased entry by its file name, an entry in CHANGELOG.md's `## Unreleased` as
  `legacy#<anchor>`, or a released one as `released#<anchor>`. A part has no `###` title when it
  extends an unreleased entry.

## Template

Copy it; don't improvise.

```markdown
---
'canopycms': minor
---

### <short title> — **<breaking (what) / behaviour change / security fix>, if any**

<!-- migration
area: Worker
action: Template first
row: <the table's short form, at most 10 words>
-->

**What changed.** One or two sentences.

**To adopt.** Concrete steps, with the import path and the call shape.

**Now deletable.** The PATTERN of local code this supersedes ("a hand-rolled filename
parser"), recognisable in any adopter's tree.
```

## Rules

`pnpm lint:changesets` checks all of these except **Length**, which `pnpm lint:docs` checks, and the
last one.

- **Bump.** The frontmatter names any of the five packages; they release together. `minor` when
  `action` is anything but `None` or `Optional`, since adopters must act. Otherwise `patch` is enough.
  Never `major`.
- **Shape.** The `###` title comes first, then the `<!-- migration` block, whose keys are `area`,
  `action`, `row` and, for a part, `extends`. A `legacy#` or `released#` anchor is the one GitHub
  shows for that heading in CHANGELOG.md.
- **Metadata.** `area` is one of AI, Assets, Auth, Branches, CDK, Editing, MDX, Ops, Preview,
  Reading, Refs, Schema or Worker. `action` is at most 5 words: who must act, or `None`. `row` is at most
  10 words.
- **To adopt** may be left out only when `action` is `None` or `Optional`. Leave out **Now
  deletable** when nothing becomes deletable.
- **No int labels.** Never write `(int.N)` or `next`: a build computes them.
- **Links** are relative to this directory: `../README.md#live-preview`. Link another unreleased
  entry as `./<file>.md`, and a CHANGELOG.md entry as `../CHANGELOG.md#<anchor>`. Write links inline:
  no reference definitions and no raw HTML. A title carries no links and must not share its anchor
  with any heading in CHANGELOG.md.
- **Length.** Each file stays within CHANGELOG.md's per-entry word cap in
  `scripts/docs-budgets.json`.
- **Public package, private adopters.** Never name files, paths, branches, hosts or identifiers
  from an adopter's repo.

`pnpm changelog:preview` prints CHANGELOG.md as the next build would ship it.
