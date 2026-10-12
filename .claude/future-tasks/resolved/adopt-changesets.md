---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-11. Changesets write CHANGELOG.md's entries (.changeset/*.md, gated in CI); int builds ship an assembled CHANGELOG.md with a "new since the previous int" handoff and are tagged v<version>; a push to main releases pending changesets as one semver version (first 0.1.0) by promote, changeset version, an atomic commit-and-tag push, and an idempotent publish run by the tag's push. PR A #524 and PR B (feat/changesets-stable-release). The first live stable release is the int-202610-b to main merge
---
# Adopt changesets for release notes and deliberate semver

## Status

RESOLVED. Both halves are built; their review rounds are recorded in each PR:
- **PR A, int side**
  ([safeinsights/canopycms#524](https://github.com/safeinsights/canopycms/pull/524), merged
  2026-10-11): `.changeset/`, `scripts/migration-notes.mjs`, the CI gate, `CHANGELOG.md`, int
  tags and the shipped changelog.
- **PR B, stable side** (`feat/changesets-stable-release`): `scripts/release-stable.mjs`,
  `--promote`, the two stable jobs, tagging through git, and `release-dry-run`.
- **Done outside the repo**:
  - the `release-tags-immutable` and `stable-tags-release-bot-only` rulesets;
  - the backfill of 33 int tags (int.74 to int.114). `gh api -X POST …/git/refs` created only
    int.114 and answered 404 for every older commit, e.g. c598fe89 (int.113), even with a tag
    already on it, on 2026-10-11; the other 32 went up with `git push origin <sha>:refs/tags/…`.

**Still to watch, live:**
- The first int published after PR A is the first live run of `tag-prerelease`.
- The int-202610-b → main merge is the first live stable release, and `release-dry-run` rehearses
  it on that PR. That a tag pushed by the app token triggers `publish` is very likely but untested
  (GitHub suppresses only `GITHUB_TOKEN` events). If `publish` does not start, dispatch
  _Publish to npm_ on the tag.
- `tag-prerelease` runs after a partly failed prerelease only if a failed reusable workflow still
  passes its `published` output. If an int goes untagged, `scripts/backfill-int-tags.mjs --push`
  tags it.

## As built in PR B (overrides the spec below where they differ)

- **`publish` runs on the stable tag's push** (`on.push.tags`), or on a manual run on the tag,
  not as a job dependent on `release-commit`. npm provenance records `GITHUB_SHA`, which then is
  the release commit. A manual run on the tag recovers any release a re-run cannot. The release
  commit carries no `[skip ci]`; its own run on main waits for CI, then finds nothing pending.
- **The release-bot token never meets dependency code.** `release-commit` checks out without
  persisted credentials and with `HUSKY=0`, commits with hooks off, and pushes from a fresh
  repository that ignores global and system git config.
- **`latest` does not move back unseen.** Each package's dist-tag is decided just before its
  publish: `superseded` when npm's `latest` or a stable tag on main is newer. Two releases
  publishing within seconds can still interleave; a `latest` still split across the five a few
  minutes later fails the run.
- **The changeset gate exempts merge-backs.** A changed file that main also changed, and that now
  matches main's copy, needs no changeset. Tests, fixtures and `AGENTS.md` are ignored, as
  changesets' `changedFilePatterns` does. A file moved out of a package needs one.
- **`release-dry-run`** runs on every PR into main, and on any other PR only when the release
  machinery changes (`publish.yml`, `ci.yml`, the release scripts, `.changeset/config.json`).
  After `--prepare` it runs release-commit's staging check, prints `git status --short`,
  refuses a version already on npm, then ships into `packages/canopycms/CHANGELOG.md` and packs.
- **`publish` checks its tag first**: a plain `vX.Y.Z` on main whose canopycms manifest holds
  that version.
- **Each stable tag has its own concurrency group**, shared by its push run and a manual run.
- **`tag-prerelease` fetches the commit's full history**: a shallow push is refused when no
  branch on the server reaches the commit.
- **`--promote`** marks every consumed changeset, empty ones included. After a release,
  `legacy#` parts, and parts whose parent a release consumed, resolve under Released. Generated
  "Added in …" headings may renumber. Links to a nested part land on its parent entry.
- **`--prepare` refuses more than the spec says**: a repository with no stable tag, a HEAD that
  lacks the latest stable tag, a pending changeset the plan leaves out (an untracked one: commit
  or stage it), a plan that does not release all five at one plain X.Y.Z, and manifests or
  `version.ts` that disagree after the bump.
- **`bump-version.mjs`** writes only an explicit version.
- **The stable publish packs all five before publishing any.** This resolves
  `publish-partial-failure-window.md`.
- **This file moved to `resolved/` in PR B itself**, not after B merged.


The design below was reviewed adversarially before any code; JP and the manager settled its six decisions (D-1 to D-6) on 2026-10-11.

## PR B spec (GO 2026-10-11)

The manager's three conditions on GO:
1. The release dry run runs on the int-b → main PR itself, not only on PRs that touch the
   release path.
2. Main's rulesets must allow the release bot's atomic push of the commit and its tag.
   Checked by reading on 2026-10-11:
   - Main is governed by `require-pr` (deletion, non_fast_forward and pull_request, with the
     release-bot app 4038189 as an `always` bypass) and by `main` (deletion and
     non_fast_forward).
   - A fast-forward push breaks neither ruleset, and `stable-tags-release-bot-only` lets the
     bot create `vX.Y.Z`.
   - There is no classic branch protection.
3. This spec lives here.

Base: `int-202610-b` at d114dade, after PR A #524. Design and decisions:
`.claude/future-tasks/adopt-changesets.md`. Its "As built in PR A" block wins over the memo.
**PR B must be on int-b before int-b merges to main.** Until then, the stable job's tripwire
refuses to publish while any changeset is pending.

### Goal

A push to `main` that CI passes does one of two things:
- releases every pending changeset as one version, with the five packages in lockstep and the
  version taken from the changesets (D-1, D-2);
- or, if nothing is release-worthy, publishes nothing (D-5).

A release:
1. promotes the Unreleased entries into `CHANGELOG.md`;
2. consumes the changesets;
3. commits and tags the release;
4. then publishes each package idempotently, with the assembled `CHANGELOG.md` in the
   canopycms tarball.

### 1. `scripts/release-stable.mjs` (new; the logic the workflow and the dry run share)

`node scripts/release-stable.mjs --prepare [--allow-dirty]` works in the current tree and
commits nothing. It prints a JSON result on stdout:

- `{"release": false, "reason": "..."}` when nothing is release-worthy:
  - no changeset files;
  - or only empty changesets: `changeset status` releases nothing, and they stay to be consumed
    by the next real release.
- Otherwise `{"release": true, "version": "X.Y.Z"}`, after doing this in order:
  1. Read the plan: `changeset status --since=<latest stable vX.Y.Z tag> --output <tmp>`. Every
     present changeset counts, as on the prerelease path.
  2. **Refuse to go backwards.** If `X.Y.Z` is not greater than both the latest stable tag and
     npm's `latest`, fail with a clear error, and never re-derive a different version.
  3. `node scripts/migration-notes.mjs --promote X.Y.Z` (§2).
  4. `pnpm exec changeset version`: bumps the five manifests and deletes the consumed
     changesets, empty ones included.
  5. `node scripts/bump-version.mjs X.Y.Z`: `version.ts` and the root manifest, which
     `changeset version` never touches.
  6. Validate with `pnpm lint:docs` and `node scripts/migration-notes.mjs --check`. Check 9 must
     now find `### X.Y.Z`.

`--self-test` runs against throwaway repos, the same way migration-notes does, and covers:
- no changesets;
- empty-only changesets;
- a patch and a minor, with every manifest and `version.ts` checked;
- the backwards refusal;
- a full prepare whose CHANGELOG.md and `.changeset/` match expectations.

### 2. `migration-notes.mjs --promote <X.Y.Z>`

- **CHANGELOG.md markers.** The legacy part of `## Unreleased` sits between
  `<!-- legacy:start -->` and `<!-- legacy:end -->` markers, which PR B adds. That covers the
  legacy paragraph, the table and the frozen `###` entries. The generic intro stays outside the
  markers.
- **The new section.** `### X.Y.Z` is written as the first child of `## Released`. In it:
  1. The legacy entries, demoted `###` → `####`, keeping their int labels.
  2. The assembled changeset entries in table order, each as `####`, with its
     `<!-- changeset: <slug> -->` marker and its `_First in int.N._` line. A changeset in no
     int tag is labelled `First in X.Y.Z`.
  3. Each changeset entry's unreleased parts as `##### Added in int.N`.
  4. Each legacy- or released-parent part as its own `####` "…, continued".
  5. Body links rebased from `.changeset/` to the repo root.
- **What is removed.** The legacy block, markers included, comes out of Unreleased. Unreleased
  keeps only its generic intro, so the next build creates a fresh table (as built in PR A).
- **Inbound links.** Every link in a tracked `*.md` outside `.changeset/` and `.claude/` that
  points at `.changeset/<slug>.md` is rewritten to `CHANGELOG.md#<anchor>`, relative to that
  file.
- **The changeset files stay.** `changeset version` consumes them. The markers are what let
  `--check`'s shipped-then-missing rule accept that they are gone.
- **Invariants, tested:**
  - every existing anchor is unchanged, and the new section's anchors collide with nothing;
  - running `--promote` twice is refused (the `### X.Y.Z` already exists).
- **Stable `--ship`** (`--version X.Y.Z` with no `-int`): the "This build" section names the
  version and links to `### X.Y.Z`, with no "New since int.M". The rest is as built in PR A.

### 3. `publish.yml`: the stable path becomes two jobs

**`release-commit`** runs on push to main, with `contents: write` through the release-bot app
token and **no** `id-token`. Its steps:
1. The CI gate (unchanged).
2. Check out with `fetch-depth: 0`.
3. Install, then `generate:client`.
4. `release-stable.mjs --prepare`. If `release: false`, write the reason to the summary, end
   green and publish nothing.
5. `git commit -m "chore: release vX.Y.Z [skip ci]"` and tag `vX.Y.Z`.
6. `git push --atomic origin HEAD:main refs/tags/vX.Y.Z`.
   - If main has moved, the push is rejected, the job fails, and nothing is published. The next
     push to main runs again from the new head, with the changesets still pending.

Its outputs are `version` and `sha` (the release commit).

**`publish`** has `needs: release-commit` and runs only if a release was made. It has
`id-token: write` and `contents: read`, and **no** write token. Its steps:
1. Check out the release commit with `fetch-depth: 0` (tags are needed for labels).
2. Build.
3. `migration-notes.mjs --ship --version X.Y.Z --sha <release sha> --out packages/canopycms/CHANGELOG.md`.
4. Pack, and assert that `package/CHANGELOG.md` is in the canopycms tarball.
5. Publish each package **idempotently**:
   - if `npm view <pkg>@X.Y.Z` exists **and** its attested `gitCommit` equals the release SHA,
     skip it;
   - if it exists at another commit, fail loudly;
   - otherwise publish.

   A publish that fails part-way is resumed with "Re-run failed jobs": it skips what is already
   on npm.

This replaces the old single job and its `--min` floor. The tripwire goes, since this path
consumes changesets. The commit-and-tag step runs first, so npm never holds a version main lacks: either nothing is pushed, or the tag exists and publishing can resume.

**Separation of privilege.** Writes happen only where no `id-token` exists, and `id-token` only
where no write token exists. That is stricter than today's single job, which holds both.

### 4. Int tagging through git (manager-approved)

- **`tag-prerelease`** still checks out nothing and runs no repo code. It does:
  1. `git init`;
  2. fetch the single commit with an auth header built from `GITHUB_TOKEN` (the same header
     form `actions/checkout` uses; no token in a URL);
  3. `git push <sha>:refs/tags/v<version>`;
  4. the existing `matching-refs` GET as the idempotence check.
- **`scripts/backfill-int-tags.mjs --push`** uses `git push origin <sha>:refs/tags/v<version>`
  (after `git fetch` if the commit is missing locally) instead of `gh api POST git/refs`.

### 5. Dry run in CI

A `release-dry-run` job in `ci.yml`, path-filtered with the `dual-build` pattern so it always
reports. It runs on every PR into `main` (the int-b → main PR's dry run matters most), and on any
other PR that touches the paths below. Its trigger paths: `.github/workflows/publish.yml`, `scripts/release-stable.mjs`,
`scripts/migration-notes.mjs`, `scripts/bump-version.mjs`, `.changeset/config.json` and
`.changeset/*.md`. It runs:

1. `release-stable.mjs --prepare` on a full checkout;
2. `--ship` into a temp file;
3. `pnpm pack` of canopycms, with the tarball assertion;
4. prints `git diff --stat` and the planned version.

It never commits, pushes or publishes. The first real run, the int-b → main merge, is thereby
rehearsed on every PR that touches the release path.

### 6. Docs

- **DEVELOPING.md Releasing:**
  - stable channel = the two jobs, D-5, and resuming with "Re-run failed jobs";
  - the `--min` paragraph is replaced by the resume rule;
  - the tripwire sentence is deleted.
- **`.changeset/README.md` and CHANGELOG.md's intro:** the "is to / until that release path
  exists" wording becomes present tense.
- **`adopt-changesets.md`:** marked resolved, with a final status. The task moves to `resolved/`
  once B merges.
- **Doc deltas** are reported, and superseded text is deleted, not appended to.

### 7. Work split, tiering and review

- **One Opus worker** writes `release-stable.mjs`, the `--promote` mode and the stable-ship
  variant, against this spec. This is design-heavy and gets self-tests with break-and-rerun.
- **The orchestrator** (this session) does the workflows, the dry-run job, the
  backfill/tag-prerelease git push, and the docs.
- **Review:**
  - `/review-rounds` with Opus code rounds;
  - the claims pass;
  - then a **Fable full-diff review**, as agreed, before reporting merge-ready.
- **Merging:** through the manager's queue, with auto-fix off until my turn.

### Open points (my recommendation in brackets)

1. **Empty-only changesets on main** stay until the next real release consumes them. [Yes.
   Deleting them in a release-less bot commit is noise.]
2. **Where `--promote` sits.** It runs before `changeset version`, so the label computation can
   still read the files. [Required by design.]
3. **Should the first stable release (int-b → main) also get a GitHub Release?** [No. Out of
   scope; CHANGELOG.md is the record.]

## As built in PR A (overrides the memo below where they differ)

- **Previous int (M)**: the nearest int tag on HEAD's first-parent chain, not the newest ancestor
  tag. After an int line merges another, the other line's tags are ancestors too.
- **Names**:
  - A changeset name deleted anywhere in HEAD's history is refused, unless M still carries it
    (a revert that came back).
  - A changeset M carries may not leave the tree unless CHANGELOG.md holds its
    `<!-- changeset: <slug> -->` marker. **PR B's promote must write that marker** for every
    changeset it consumes.
- **Bodies**: no reference definitions, no raw HTML beyond comments, and no links in titles.
  Images link to `raw/<sha>`, and a leading `/` is repo-root-relative.
- **Version plan**: `changeset status --since=<latest stable tag>`, floored at main's version
  patch-bumped.
- **Gate**: the root-file rule also covers `tsconfig.base.json`.
- **Word cap**: check-docs applies CHANGELOG.md's `maxEntryWords` (275) to each changeset file,
  per the manager's ruling. There is no separate ~300-word rule.
- **`--promote`** is not in PR A. It belongs to PR B, with `changeset version` and the stable
  ship.
  **PR B must also run `--ship` and the tarball check in the stable job**: today only the
  prerelease path writes and checks `packages/canopycms/CHANGELOG.md`.
- **`legacy-unreleased.md`** (minor) owns the frozen Unreleased entries.
- **Tags**: tag-prerelease looks tags up through `git/matching-refs` and runs once canopycms is
  published. `scripts/backfill-int-tags.mjs` tags the ints published before it.

## Rev 3 changes (JP, 2026-10-11). Where this block and the sections below disagree, this block wins.

1. **A committed root `CHANGELOG.md` replaces `docs/adopter-migration.md`.**
   - The cutover renames the file with `git mv` (history kept).
   - Its entries keep the migration format: Area/Action, What changed / To adopt / Now deletable.
   - The "How to use" preamble moves to the top of the changelog.
   - The release bot writes each `### X.Y.Z` under `## Released` into it at a stable release (the current structure, which #516's Released exemption relies on).
   - The tarball's `CHANGELOG.md` is that same file, plus an assembled "Unreleased / New since
     int.M" section for int builds. One name everywhere: it is the first file an agent looks for,
     in the repo and in `node_modules`.
   - Changesets' own per-package changelog writer stays off (`changelog: false`), because the
     five packages release in lockstep.
   - Cost:
     - 3 inbound anchor links;
     - the `packages/canopycms/README.md` mentions;
     - check 9's hard-coded path (`check-docs.mjs:669`);
     - the budgets entry: `CHANGELOG.md` must be added to `BUDGET_ROOT_FILES` as a
       changelog-type file.
   - **Old D-4 (ship a file in the tarball) is gone**: the changelog lives in the repo either way,
     and shipping it is just packaging.
2. **Word caps are out of this plan.** The session "Cap migration-guide entries, not the whole
   file" owns entry and section caps on this file. This plan drops its own ~300-word rule and its
   `check-docs` budget edits.
   - `lint:changesets` applies whatever per-entry cap that session lands to each changeset file.
   - Ordering: if that work lands first, PR A carries its cap over to the renamed file and to
     changesets. If not, that session follows the rename.
3. **Two PRs, not six** (§10 below).
4. **Work between PR A and PR B** (§10 below): free, with one hard constraint.
5. **Decided (2026-10-11).** All six decisions take option (a): D-1, D-2, D-4, D-5 and D-6 as
   recommended, D-3 as recommended including the backfill. JP explicitly confirmed D-1, D-5 and
   D-3; the manager agreed to all six.
   - **The D-3 rulesets are live**, created by this session at JP's request on 2026-10-11:
     - `release-tags-immutable` (id 24895273): `refs/tags/v*`, blocks deletion and update;
       bypass: repository admins.
     - `stable-tags-release-bot-only` (id 24895274): `refs/tags/v*` excluding
       `refs/tags/v*-*`, restricts creation; bypass: `canopycms-release-bot` (app 4038189) and
       repository admins.
     - Int tags (`v*-int.N`) can be created by any writer, including the tag job's
       `GITHUB_TOKEN`, but never moved or deleted except by an admin. Nothing has exercised this
       yet for a non-admin actor; PR A's first int publish is that test.
   - The backfill of int.93–113 runs from PR A's reviewed script, not by hand.

---

## 0. Summary

Every PR that changes something an adopter can see adds **one file, `.changeset/<slug>.md`, which
is that PR's whole migration entry**: changesets frontmatter for the bump, then the entry's title,
Area, Action, and What changed / To adopt / Now deletable. No PR edits
`docs/adopter-migration.md` again. A script assembles the entries in two places:

- **At each int publish**, into a `CHANGELOG.md` shipped inside the `canopycms` tarball. Each
  entry's int label is computed, not typed. A "new since the previous int" handoff goes into the
  file and into the Actions job summary; it is computed as a set difference of files, not by
  comparing labels.
- **At each stable release**, into a `### X.Y.Z` section of `docs/adopter-migration.md`. The
  release bot writes it in the same commit that runs `changeset version`.

Int prereleases keep their `int.N` numbers: N stays `publish.yml`'s run number, so "int.112"
means what it means today. Pre mode is rejected (§3). From changesets we use four things: the
file format, the `fixed`-group bump arithmetic, the CI gate (`changeset status --since`), and the
consumption of changeset files at release. Its changelog writer is switched off.

**Six decisions need JP (§9).** The biggest is whether the first release under this scheme is
`0.1.0`. A tag ruleset is also a settings action only JP can take.

---

## 1. Today's machinery and the measured pain

### What exists

| Piece | Behaviour (read from source) |
| --- | --- |
| `publish.yml`, stable job | On a push to `main`: wait for CI on the SHA, then `bump-version.mjs --min <registry latest>` (patch), then build, then `pnpm pack` + `npm publish` for all five. The release bot then commits the bump and tags `vX.Y.Z` with `[skip ci]`. **Every push to main publishes a patch, once CI's `validate` passes.** Main is at `0.0.67` and already carries unpublished content: the #381 int-a → main merge (run 99) stopped at the CI gate, and npm has no `0.0.68`. |
| `publish.yml` → `publish-prerelease.yml` | Runs on `workflow_dispatch` on a non-main branch. Version = `prerelease-version.mjs(<main's committed version>, $GITHUB_RUN_NUMBER)` = `0.0.68-int.N`. **N is publish.yml's run number, shared with push runs; the version is not derived from the registry.** Only the stable path is floored on the registry. The job is `contents: read` by design: it never writes to the branch and creates no tag. It publishes under the `int` dist-tag. |
| `scripts/bump-version.mjs` | Writes one version into the five `packages/*/package.json`, the root `package.json`, and `packages/canopycms/src/version.ts`. Modes: patch, explicit `<version>`, `--min`. |
| Five lockstep packages | `canopycms`, `canopycms-next`, `canopycms-auth-clerk`, `canopycms-auth-dev`, `canopycms-cdk`. The other four peer-depend on `canopycms: workspace:*`, which `pnpm pack` turns into an exact pin. `files: ["dist"]`, plus the worker and lambda dists for cdk. cdk's worker is an esbuild **bundle** that includes third-party code. |
| `docs/adopter-migration.md` | 1,588 lines: a 46-row Unreleased table (`int`/Area/Change/Action), ~45 `###` entries, and Released `### <version>` sections. Authors label new work `next`. **Before each int publish, someone replaces every `next` with the int number by hand.** Entries gain later parts labelled `(int.N)`. Promotion to Released is manual. |
| `scripts/check-docs.mjs` | Check 9: every `vX.Y.Z` tag reachable from HEAD needs a `### X.Y.Z`; the check is inert on a shallow clone and filters out `-int.` tags. Word budget for `adopter-migration.md`: `words 10144`, `maxSectionWords 5267`, which binds **Unreleased** (5,265 by the checker's own count). Released is exempt from the section ceiling (`historyMarkers: null`) but **not from total words**. Links are checked for file existence only, **never their `#anchor`**. |
| `packages/canopycms/README.md` | "This package ships code, not documentation." Adopters resolve the build's git ref from the npm provenance attestation and read the docs on GitHub. |
| DEVELOPING.md | **Has no release section.** The release flow lives only in workflow comments, the migration doc's rules, and the `bump-version` test notes (`DEVELOPING.md:1043-1064`). |

### Measured pain (`git log --first-parent --merges origin/int-202610-b`)

- **Since 2026-10-06:** about 89–90 PR merges into int-202610-b (the count depends on the
  timezone boundary). **55 touched `adopter-migration.md`; 45–46 touched
  `scripts/docs-budgets.json`.** In 43 of the budget-touching merges the change included
  adopter-migration's entry, but **only 16 changed that entry alone**.
- **Since 2026-10-09:** 30 of 55 PR branches had to merge int-b in first. In those int merges,
  `adopter-migration.md` changed on both sides 19 times and `docs-budgets.json` 18 times
  (`git show --cc`, so this is an upper bound on real conflicts). `CODEBASE_GUIDE.md` (13) and
  `.claude/future-tasks/index.md` (10) come next; this memo does not fix them (§10).
- **One bookkeeping PR per int:** int.110–113 needed #478, #484, #492 and #503. The relabel
  commit **predicts the run number**: #503's commit says "int.113 is published from this commit".
  A push to main in between would have taken run 113.
- **Ints come from more than one branch.** int.104 was published from
  `release/int-104-pre-mdx4`, and int-202610-ui is an active int branch. "The previous int" is not
  always an ancestor of HEAD.

---

## 2. Verified changesets facts (pinned: `@changesets/cli@3.0.3`)

`@changesets/cli@3.0.3` (released 2026-09-14) is current; 3.0.0 shipped 2026-08-11. Every claim
below was **read in the installed `dist/` source** of the exact sub-package that 3.0.3 resolves
to. Claims marked ▶ were also **run** in a scratch 5-package pnpm monorepo. The reviewer
re-checked V1, V4–V8, V10, V12, V16, V17 and the packaging claim independently. Resolved
sub-packages: `parse@1.0.0`, `read@1.0.1`, `assemble-release-plan@7.0.0`,
`apply-release-plan@8.1.1`, `config@4.0.1`, `git@4.0.1`, `pre@3.0.0`. **Nothing here was checked
against 2.x, so pin 3.x exactly.**

| # | Claim | Evidence |
| --- | --- | --- |
| V1 | The frontmatter must map **package name → `major`/`minor`/`patch`/`none`**. Any other key is a parse error or an unknown package, so **metadata cannot go in the frontmatter.** | `parse`, `validateReleases`. `assemble-release-plan` throws "Found changeset … for package X which is not in the workspace" |
| V2 | The summary is the trimmed body after the frontmatter, verbatim. | `parse`; ▶ |
| V3 | In a `fixed` group, if any member releases, **every** non-skipped member releases at the highest bump type, starting from the group's highest current version. ▶ A patch in cdk takes all five to 0.0.68; adding one `minor` takes all five to 0.1.0. | `matchFixedConstraint`; ▶ |
| V4 | Peer dependents get **patch, never major**. `workspace:*` resolves to the old version, so any bump falls outside its range. | `determineDependents` |
| V5 | `version` does not rewrite `workspace:*`/`^`/`~` ranges. | `getDependencyVersionEdits` |
| V6 | `version` never sets the root `version` and never touches `src/version.ts`; `bump-version.mjs <explicit>` must still run after it. | `applyReleasePlan` |
| V7 | `privatePackages` defaults to `{version:false, tag:false}`, so `apps/*` are skipped. A changeset that mixes skipped and released packages is an error. | `config` ~779; `getRelevantChangesets` |
| V8 | `status` exits 1 **only if** a versionable package changed since the merge-base **and** no changeset was added or modified since then. **Any such changeset passes, including an empty one or an edit to an existing one.** ▶ | `status.mjs:22-31`; ▶ |
| V9 | `--since <ref>` diffs `git merge-base <ref> HEAD` against the **working tree** (`git diff --name-only <base>`). Uncommitted edits to tracked files count; untracked files do not ▶. Without `--since`, `baseBranch` must exist as a **local** branch, or it crashes with "Failed to find where HEAD diverged". The merge-base must be in the clone. | `git/dist:35-42,108-137`; ▶ (both) |
| V10 | `changedFilePatterns` (default `["**"]`, supports negation) narrows "changed package". It cannot see files outside package directories. | `git.getChangedPackagesSinceRef` |
| V11 | `status --output plan.json` writes the release plan (`newVersion` per package) without touching the tree. **When the gate condition fails, it exits 1 before writing the file.** | `status.mjs`; ▶ |
| V12 | `version` with **zero** changesets exits 1. With **only empty** ones, it deletes them and bumps nothing. ▶ | `version.mjs:59-62`; ▶ |
| V13 | **Pre mode** keeps its state in a committed `.changeset/pre.json`. Its counter is the current `package.json` prerelease number + 1. Each pre `version` moves consumed changesets into `.changeset/pre/`, so it needs a commit. Snapshot is refused in pre mode. | `pre/dist`, `getPreVersion`, `applyReleasePlan` |
| V14 | **Snapshot** uses `0.0.0-<suffix>` unless `useCalculatedVersion: true`. Template placeholders: `{tag}`, `{commit}`, `{commit-short}`, `{timestamp}`, `{datetime}`. ▶ `useCalculatedVersion` + `{tag}` + `--snapshot int.114` gives `0.0.68-int.114` for all five. It **deletes changeset files from the working tree** and exits 1 with none present. | `getSnapshotSuffix`; ▶ |
| V15 | The changelog writer is pluggable, or off with `changelog: false`. The default puts a changeset's whole summary into one list item under the changeset's *own* bump type (`### Patch Changes` even when the group released a minor). Packages without their own changeset get only "Updated dependencies". ▶ | `apply-release-plan`, `changelog-git`; ▶ |
| V16 | `read` ignores `README.md` (any case), `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and dotfiles in `.changeset/`. | `read/dist:6-37` |
| V17 | `changeset add` takes `--empty`, `-m`, and `--major/--minor/--patch <pkg>`. ▶ | cac definitions; ▶ |
| V18 | `format` (default `"auto"`) formats generated CHANGELOGs **and the changesets written by `add`**. | `config`; `write/dist:26,36` |

**Packaging** (▶ with this repo's `pnpm@10.12.1`; reviewer re-ran it): with `files: ["dist"]`,
`pnpm pack` ships `package.json`, `README.md`, `LICENSE` and `dist/` and **leaves out
`CHANGELOG.md`**. Listing a file in `files` includes it, **even when it is git-ignored**. Files
outside the package directory cannot be included, so the shipped file must be **generated into
`packages/canopycms/` before packing**.

---

## 3. Decision 1: prerelease numbering

| Option | Mechanics | Adopter impact |
| --- | --- | --- |
| **A. Keep `int.N` = run number.** Changesets drives notes and the stable bump. | `prerelease-version.mjs` keeps its shape. | None. |
| A′. As A, but the **base** is changesets' calculated next version. | The job counts `.changeset/*.md`, ignoring the names V16 skips. With none, base = main + patch, as today. Otherwise it runs `status --since=origin/main --output` (never without `--since`, V9) and uses `newVersion`; any failure is fatal (V11). It gives the same strings as snapshot (V14) without touching the tree. | The version string jumps once, e.g. `0.0.68-int.115` → `0.1.0-int.116`. The N stays unique. The `int` dist-tag may later move to a lower semver if an int comes from a branch without the minor. That is legal, and the channel already means "last published". |
| B. Pre mode | V13 | **Rejected.** Numbers would restart below int.113 unless seeded by hand. The prerelease job would have to commit versions and `.changeset/pre/` moves back to the branch, reversing `contents: read`. Every int branch would carry its own `pre.json` and conflict on merge, the same class of hot spot this removes. |
| C. Snapshot as the mechanism | V14 | Same numbers as A′, but it mutates the tree, deletes changesets before assembly, and exits 1 on a branch with none. A′ is strictly safer. |

**Recommendation: A′, landing in the cutover PR (5), not before.** Before cutover there are no
changesets, so A′ reduces to A. Without D-1(a) it also reduces to A.

---

## 4. Decision 2: what a changeset carries

**Options.**
- **A.** The changeset *is* the migration entry, and a script assembles it.
- **B.** `adopter-migration.md` stays hand-written, and changesets carry the bump plus a one-liner.
  This leaves the hot spot in place.
- **C.** A generated per-package `CHANGELOG.md` replaces the guide. Rejected because of V15: it
  flattens structure, mislabels the bump, and scatters entries over five files, four of which say
  only "Updated dependencies".

**Recommendation: A.**

### File format

The frontmatter belongs to changesets alone (V1). Metadata goes in a YAML block inside an HTML
comment:

```markdown
---
"canopycms-cdk": minor
---

### `canopycms-cdk`: the worker needs a state directory — **deploy the template before the bundle**

<!-- migration
area: Worker
action: Template first
row: Worker needs a state directory
-->

**What changed.** …

**To adopt.** …

**Now deletable.** …
```

- **Parts.** `extends: <target>` makes the file a later **part** of another entry. The target is
  one of three things:
  - an unreleased slug, which nests the part under that entry;
  - **`legacy#<anchor>`**, an entry in the frozen legacy section;
  - **`released#<anchor>`**.

  A part whose parent is legacy or released renders as its own entry, titled
  "<parent title>, continued", and links to the parent. This covers the cutover's own case:
  the `next` part of "The worker never pushes the base or default branch". It also covers a
  part whose parent was consumed by a stable release before its branch merged main.

  **Never edit a shipped changeset to add a part; add an `extends` file.** Corrections in place
  are allowed. The lint warns when a file present in the newest ancestor int tag has changed
  since that tag.
- **Empty changesets** (`changeset add --empty`) are for PRs that change a package without an
  adopter-visible effect. They render nothing.
- **Slugs.** Slug = filename, kebab-case, written by the author; agents write the file directly.
  A **slug may never be reused**: the lint refuses a slug that appears in any int tag's tree
  unless the newest ancestor int tag also has it, so the file has been present continuously.
  An entry that is reverted and relanded takes a new slug, which keeps its label honest.
- **Anchors.** Anchors use GitHub's algorithm, with `github-slugger` pinned. The lint refuses an
  H3 whose slug collides with any heading already in `adopter-migration.md` or in another
  changeset. Released is newest-first, so a duplicate title would otherwise take the bare slug
  and silently shift an older entry's anchor to `-1`.
- **Links.** `.changeset/` and `docs/` are both one level deep, so `../README.md#x` resolves the
  same from either.
  - A link to another unreleased entry is written `./<slug>.md`, and the assembler rewrites it to
    `#<anchor>`.
  - A link into Released is written `../docs/adopter-migration.md#<anchor>`.
  - Other docs link to an unreleased entry as `.changeset/<slug>.md`. `--promote` rewrites those
    links repo-wide. Today there are 3 inbound anchor links.
  - `lint:docs` already checks that these **files** exist (`.changeset/` is not in `EXCLUDED`).
    **Anchors are checked by `migration-notes --check`**, because `check-docs` strips them.
- **`.changeset/README.md`** holds the author guide and template (V16). It replaces the template
  comment at `adopter-migration.md:760`.

### `lint:changesets` = `scripts/migration-notes.mjs --check`

It parses with `@changesets/parse`, pinned as a **direct exact devDependency**, because pnpm's
strict layout would not resolve a transitive dependency from `scripts/`. Rules:

1. Every entry has an H3 title and a metadata block. `area` comes from the current list (Branches,
   Reading, Editing, Preview, Refs, CDK, Ops, Assets, Auth, Schema, MDX, Worker). `action` is at
   most ~5 words, `row` at most ~10.
2. **The bump matches the action** (D-2): any action other than `None` or `Optional` ⇒ `minor`.
   `major` is refused until JP schedules 1.0.
3. No hand-written labels: `(int.N)` and `next` are refused in changeset bodies.
4. `extends` resolves to a slug, `legacy#…` or `released#…` anchor, and chains at most one deep.
5. Anchor rules and the slug-reuse rule above.
6. At most ~300 words per entry. This replaces the 5,267-word Unreleased ceiling.
7. Never naming an adopter's files, hosts or identifiers stays a **review** rule, not a lint.

Rules 5 and the shipped-change warning need history and tags, so **the CI job running this lint
checks out with `fetch-depth: 0`** (ci.yml's `lint` job is depth 1 today). Locally, the rules
that need tags no-op when the tags are absent and say so, like check 9.

---

## 5. Decision 3: release notes and the handoff

### The int → commit map

| Option | Mechanics | Trade-off |
| --- | --- | --- |
| **T1. Tag each int** as `v<version>` (e.g. `v0.0.68-int.114`) at the published SHA. | See the hardening below. Backfill int.93–113 once from `gh run list --workflow=publish.yml` `headSha`, cross-checked against T2. | Works offline afterwards. Adopters get `tree/v0.0.68-int.112` instead of the attestation one-liner. It adds a write to the prerelease path, so it needs a JP decision (D-3). |
| T2. npm provenance attestations | Read-only, already exists. | Network only, so no lint can use it. Use it to verify the backfill. |
| T3. `gh run list` | Read-only, needs `actions: read`. | Use it for the backfill. |

**T1 hardening (review finding 5).** The live rulesets (`require-pr`, `main`) target only
`~DEFAULT_BRANCH`, and **no tag ruleset exists**. A job with `contents: write` could therefore
push to int branches and move or delete `v0.0.67`. So:

1. The tag job does **no checkout, no install, and runs no repo code**. It is one
   `gh api repos/…/git/refs` call, with the version and SHA passed in through `env`. It is
   idempotent: a tag that already exists at the same SHA counts as success.
2. `publish-prerelease.yml` declares `outputs` (version, SHA) for the caller, which it has none of
   today.
3. **JP adds a tag ruleset** on `refs/tags/v*` that blocks update and deletion, and restricts
   creating stable `vX.Y.Z` tags to the release bot. Without it, T1 widens the blast radius of
   `publish.yml`.

**Recommendation: T1 with the hardening; backfill from T3, verified against T2.**

### Labels are for display; "new since" is a set difference (review finding 2)

- **Label** = the first int tag, by N, whose tree contains the file. That matches today's
  definition, "the first int prerelease carrying an entry". At ship time, a file in no tag gets
  this run's N. In local previews it gets `next`, the only place `next` survives. At `--promote`,
  a file in no int tag is labelled with the release version.
- **"New since"** is **not** "label > M". An entry that was published first by int-ui as int.110
  and merged into int-b after int-b's int.113 would be missed. So: M = the newest int tag that is
  an ancestor of HEAD. **New** = files in HEAD's `.changeset/` that are absent from M's tree.
  **Revised** = files in both whose content differs. For the legacy section, the shipped copy
  diffs its `###` headings and labelled parts against M's copy of `adopter-migration.md`.
- **Cross-branch upgrades.** Every entry in the shipped file carries its slug (in an HTML
  comment). The "How to use" in the shipped file says: if your previous build came from another
  branch, diff the slug lists of the two `CHANGELOG.md`s
  (`npm pack canopycms@<old>` fetches the old one). The job summary shows the same set-difference
  handoff.

### What ships

`scripts/migration-notes.mjs --ship` runs at **every** publish, int and stable. It writes
`packages/canopycms/CHANGELOG.md`, which is git-ignored and added to `files`. The file contains:

1. **This build**: the version, the source SHA, and M.
2. **New since int.M** and **Revised since int.M**. This *is* the handoff.
3. **How to use**, rewritten for the shipped copy.
4. **Unreleased**: the frozen legacy section, then the assembled changesets with the generated
   table and computed labels.
5. **Released**, copied from `docs/adopter-migration.md`.
6. Every relative link rewritten to `https://github.com/safeinsights/canopycms/blob/<sha>/…`.

**Why `CHANGELOG.md`, and only in `canopycms`:** it is the first file an agent opens when asked
"what changed". Every adopter installs `canopycms`, because the other four peer-depend on it. The
other four READMEs get a one-line pointer. `packages/canopycms/README.md`'s "Which documentation
matches this build" now says to read `node_modules/canopycms/CHANGELOG.md` first, and to use the
tag route for the other guides. That reverses "ships code, not documentation" for one file (D-4).

**The hand-written handoff becomes:** "Upgrade to `<version>`; read
`node_modules/canopycms/CHANGELOG.md` → *New since int.M*." It can be pasted from the job
summary. A CI step runs `pnpm pack` and asserts `package/CHANGELOG.md` is in the tarball.

### At a stable release

Before `changeset version` consumes the files, `--promote X.Y.Z` does three things:

1. Writes `### X.Y.Z` into `## Released`: legacy entries first, then the assembled changesets,
   with H3 demoted to H4 and labels kept.
2. Rewrites inbound `.changeset/<slug>.md` links.
3. Empties the legacy section.

The bot commit carries `[skip ci]`, so **the stable job runs `pnpm lint:docs` and
`migration-notes --check` after promote and before publishing**. A bad promote then fails the
release instead of landing unchecked on main. Check 9 is satisfied by construction and stays as
a backstop. `.changeset/config.json` sets `changelog: false` and `format: false`, so the
assembler is the only writer.

---

## 6. Decision 4: versioning policy under 0.x

npm's caret: `^0.1.2` = `>=0.1.2 <0.2.0`, but `^0.0.67` = exactly `0.0.67`. On `0.0.x` no adopter
range ever takes a fix, so the bump type carries no signal.

**Recommendation:** release `0.1.0` first, then follow these rules:

- **minor**: any entry whose Action is not `None`/`Optional`. That includes breaking API, config
  or types; behaviour changes that need action; Template first; and security fixes that need
  adopter action.
- **patch**: opt-in features, fixes, and behaviour changes that need no action.
- **major**: refused until 1.0.

The packages stay `fixed` (V3).

**Legacy and main's unreleased content (review finding 3).** `status` and `version` see only
changeset files. The frozen legacy section, which includes breaking entries, and main's own
unpublished #381 content would otherwise release as `0.0.68`, or not at all under D-5. So **the
cutover PR adds `.changeset/legacy-unreleased.md`** (`canopycms: minor` under D-1(a), `patch`
under D-1(b)) with metadata `legacy: true`. The assembler renders the frozen section in its
place. That forces the first release to the intended version and gives the legacy section one
owner, so there is no special-case "copy verbatim" path.

The alternative is to stay on `0.0.x`, with every changeset `patch`. Changesets then handles notes
and the gate only (D-1).

---

## 7. Decision 5: gates

1. **A CI `changesets` job that always runs** (review finding 1). `validate` has `if: always()` and
   fails on any need that is not `success`, a **skipped** need included (ci.yml:368-383). It also
   runs on pushes to main, and `publish.yml` publishes only after CI succeeds. A `pull_request`-only
   or `created_at`-skipped job in `validate`'s `needs` would therefore block every stable publish.
   So the job runs on every event and gates per step, following the `dual-build` pattern
   (ci.yml:398-496):
   - On `push`, it echoes and exits 0.
   - On a PR, it checks out with `fetch-depth: 0` and runs
     `pnpm exec changeset status --since=origin/${{ github.base_ref }}` (V8, V9). That works for
     PRs into main and into any int branch, including int-ui → int-b. Merges from the base branch
     add nothing, because the diff is taken from the merge-base. Fork PRs need no secrets, since
     the step is read-only.
   - `changedFilePatterns` is
     `["**", "!**/*.test.ts", "!**/*.test.tsx", "!**/__fixtures__/**", "!**/AGENTS.md"]`;
     the PR verifies the exact list against V10.
   - **Root files that change shipped bytes** (review finding 13): `pnpm-lock.yaml`,
     `pnpm-workspace.yaml` and `scripts/add-js-extensions.mjs` alter cdk's esbuild worker bundle
     or every package's `dist` without touching a package directory. A small script step treats a
     change to any of them as a change to the fixed group, so a changeset is required. An empty
     one is fine for devDep-only lockfile churn.
2. **`lint:changesets`** (§4), in a job checked out with `fetch-depth: 0`.
3. **`lint:docs`:**
   - Changelog-type files (`historyMarkers: null`) exclude `## Released` from the **total** word
     count as well, so a promotion never fails the next PR.
   - After cutover, `adopter-migration.md` has nothing under Unreleased that a PR may edit, so
     its budget numbers stop moving. **That removes about a third of `docs-budgets.json`
     writes**: the 16 merges since 10-06 that touched only this entry. In the other 27, the PR
     also changed other docs' budgets, and those remain (§10).
4. **Prerelease precondition:** refuse an int when the latest stable `vX.Y.Z` tag is not an
   ancestor of HEAD ("merge main first"). Otherwise consumed changesets would ship again as
   unreleased. A `workflow_dispatch` input `allow_stale_base` overrides it, for an older-lineage
   `release/*` branch like int.104's.

**Does the budget stop thrashing?** For this file, yes: no PR writes it; only the release bot
does, and only into the exempt Released section. `docs-budgets.json` as a whole still churns
for other docs.

---

## 8. Decision 6: rollout

**Existing entries: freeze them, don't convert them.** The Unreleased section becomes
"Unreleased (before changesets)", is owned by `legacy-unreleased.md` (§6), and is promoted with
the first stable release. Converting ~45 entries would need explicit-label metadata, because git
would record every file as added at cutover, and the section only lives until int-b reaches main.
The cutover PR moves the two remaining `next` items into changesets. One is the entry "GitHub
objects cross as bundles". The other is the `next` part of "The worker never pushes the base or
default branch", which becomes `extends: legacy#the-worker-never-pushes-the-base-or-default-branch--security-fix`.

**Grandfathering (review finding 10; this departs from the brief, so it is D-6).** The brief says
the cutover "applies only to PRs opened after it lands". If a grandfathered PR may still add a
legacy `next` entry, then:

- the bookkeeping relabel survives;
- that entry falls out of the computed handoff;
- the doc and its budget keep moving.

**Recommendation:** grandfather only the *requirement to carry a changeset*. The gate step skips
when `created_at` is before the cutover constant. **Adding a `next` label to
`adopter-migration.md` is refused for every PR from cutover on.** A grandfathered PR with an
entry converts it into a changeset when it next merges int, which takes minutes. That merge
almost always touches this file anyway (55 of ~90 merges). The fallback, if JP wants strict
grandfathering: a ratchet whose count of legacy `next` labels can only fall, with hand relabels
for those entries only, until it reaches zero.

**Timing:**

- PRs 1–3 (§10) change nothing for authors and can land any time on int-202610-b.
- **Cutover (PR 4) lands right after an int publish** (int.114 or later), so the legacy section
  holds no new `next` items. Announce it beforehand to the process-split coordinator and the UI
  epic. Process-split PR 6 (template; GO sent): if it merges first, it uses the legacy section and
  its `next` item is converted in the cutover PR. If it merges after, it writes a changeset. Its
  Template-first entry would make a good first real one. PR 7 (docs, parked) comes after.
- int-202610-ui gets the tooling when it next merges int-b. Its PRs are gated against
  `origin/int-202610-ui`.
- **The stable path (PR 6 below) takes effect only at the int-b → main merge**, because the stable
  job runs from main. That merge is the first changesets release and also carries main's unpublished
  #381 content. It needs a dry-run job and a Fable full-diff review.
- After any stable release, open int branches merge main before their next int (§7.4).

**Rejected alternative:** cut over at the int-b → main merge. The pain would continue until a date
set by the process split and the UI epic.

---

## 9. Decisions (rev 3: manager input first, then JP for anything left open)

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D-1 | Make the first release under changesets **0.1.0**, after which minor = adopters must act and patch = no action | (a) 0.1.0 + the §6 policy; (b) stay on 0.0.x, every bump a patch | **(a)**. On 0.0.x a caret range pins exactly, so a version carries no signal. |
| D-2 | How the bump is chosen | (a) minor iff Action ≠ None/Optional, enforced by lint; major refused until 1.0; (b) the author's judgment | **(a)** |
| D-3 | Int tags `v<version>`, created by a no-code tag job, plus a one-time backfill of int.93–113 (~21 tag pushes) | (a) yes, *with* a JP tag ruleset on `refs/tags/v*` (no update or delete; stable tags from the release bot only); (b) no tags, labels from npm attestations (network-only, no lint) | **(a)**. There are no tag rulesets today, so without one the tag job could move `v0.0.67`. |
| D-4 | Committed root `CHANGELOG.md` replaces `docs/adopter-migration.md` (rev 3 item 1) | (a) rename to the root changelog; (b) keep `adopter-migration.md` and only ship it in the tarball | **(a)**. JP proposed it. |
| D-5 | A push to main with no release-worthy changeset publishes nothing (today every push to main publishes a patch) | (a) publish nothing; (b) a Version-PR flow; (c) force a patch on every push | **(a)**. Int branches already batch releases. |
| D-6 | Grandfathering at cutover (departs from the brief) | (a) PRs opened before cutover skip the changeset requirement, but no PR may add a legacy `next` entry; (b) strict: old PRs keep the legacy flow, with a falling ratchet and hand relabels | **(a)** |

---

## 10. PR breakdown (rev 3: two PRs)

PRs 1–4 of rev 2 delivered nothing on their own. The cutover also cannot land without shipping,
or no int would carry the notes in between. So:

| PR | Content | Preconditions |
| --- | --- | --- |
| **A: int side** | <ul><li>Exact devDeps `@changesets/cli@3.0.3`, `@changesets/parse@1.0.0`, `github-slugger`; lockfile grafted.</li><li>`.changeset/config.json` and `.changeset/README.md`.</li><li>`scripts/migration-notes.mjs` (`--check/--preview/--ship/--promote`) with subprocess tests.</li><li>`lint:changesets` and the always-run CI gate (both `fetch-depth: 0`), with the root-file rule and the `created_at` constant.</li><li>Cutover: `git mv` to `CHANGELOG.md`; freeze the legacy section with `legacy-unreleased.md`; move the 2 `next` items into changesets; refuse new `next` labels.</li><li>Int tags: the no-code tag job, the backfill script, and the merge-main-first precondition with its override.</li><li>`--ship` into the int tarball, the pack-contents assertion, and the job-summary handoff.</li><li>A′ base computation.</li><li>The **tripwire** below.</li><li>A DEVELOPING.md **Releasing** section; the `packages/canopycms/README.md` "Which documentation" rewrite.</li></ul>Lands right after an int publish, announced to the process-split coordinator and the UI epic. | D-1, D-2, D-3 + ruleset, D-4, D-6 |
| **B: stable side** | In order:<ol><li>`status --output`; if nothing releases, stop (D-5).</li><li>`--promote` into `CHANGELOG.md`.</li><li>`changeset version`.</li><li>`bump-version.mjs <newVersion>`.</li><li>`lint:docs` + `--check`.</li><li>Commit and tag **first**.</li><li>Publish each package idempotently.</li></ol>Plus a `release-dry-run` CI job and a stable checkout with `fetch-depth: 0`. Fable full-diff review. | A, D-5 |

### Can other work land between A and B? Yes, with one hard constraint

- **Unconstrained.** PRs into int-202610-b or int-202610-ui keep landing as usual: each writes a
  changeset, and int publishes work from A on. A hotfix PR straight to main is fine too: main has
  neither A nor any `.changeset/`, so its old patch flow behaves as today.
- **Hard constraint: B must be on int-202610-b before int-202610-b merges to main.** The stable job
  runs from main. If int-b reached main with A but not B, the old job would:
  - publish 0.0.68 by patch;
  - ignore the changesets;
  - promote nothing.

  Unconsumed changesets would then ship again as "unreleased" in later ints.
- **Tripwire in A, fail-closed.** A adds one step to the *current* stable job: refuse to publish
  if any `.changeset/*.md` other than `README.md` exists. An early merge then stops loudly
  instead of releasing wrong, and B replaces the step.
- **Rebase risk.** B edits `publish.yml`. Any PR that touches `publish.yml` between A and B
  (none known today) means B merges it in and re-runs its dry run.

**Out of scope, to file in `.claude/future-tasks/` once GO arrives:** `CODEBASE_GUIDE.md` and
`.claude/future-tasks/index.md` are the next shared hot spots, and `scripts/docs-budgets.json`
still churns for other docs.

---

## 11. Risks

- **The first stable run of PR 6 is at the int-b → main merge**, the highest-stakes merge, which
  also carries #381. Mitigation: the dry-run job, plus a rehearsal on a scratch fork before that
  merge.
- **An interrupted stable publish.** PR 6 commits and tags *before* publishing, and publishes
  idempotently per package. If the run dies mid-publish, main and the tag are correct, and the
  next run publishes only the packages still missing. If the bot's push is rejected because main
  moved, nothing has been published yet. The run fails cleanly, and the next push recomputes on
  top of the new HEAD. This replaces the `--min` self-heal, which re-derived the version from the
  committed patch.
- **Supply chain.** The changesets closure is about 44 packages (17 `@changesets/*`, plus @clack,
  @manypkg, @pnpm, human-id, launch-editor, shell-quote and others). PR 6 **executes**
  `changeset status/version` in the job that holds `id-token: write` and the release-bot token
  that bypasses PR review on main. The marginal risk is small, because `pnpm install` lifecycle
  scripts already run in that job, but it is real. Exact pins and the existing integrity checks
  apply.
- **Agents writing changesets by hand get the format wrong.** `--check` catches it; the README
  template carries the rest.

---

## 12. Adversarial review (one round, Opus, 49 tool calls; independent re-verification)

| # | Sev | Finding | Response |
| --- | --- | --- | --- |
| 1 | HIGH | A `pull_request`-only (or `created_at`-skipped) job in `validate`'s needs is *skipped* on pushes to main, `validate` fails, and `publish.yml` never publishes. | **Accepted.** I verified ci.yml:368-383 and publish.yml:91-103. The job always runs and gates per step (§7.1). |
| 2 | HIGH | "label > M" misses entries first published from another branch (int-ui, `release/*`). | **Accepted.** Labels are display-only. "New/Revised since M" is a set difference of files against M's tree. The shipped file carries slugs for cross-branch diffs (§5). |
| 3 | HIGH | The legacy section and main's unpublished #381 content have no changeset, so the first stable release could be `0.0.68` or nothing. | **Accepted.** I verified main is at 0.0.67 with #381 merged and npm has no 0.0.68. Added `legacy-unreleased.md` (§6), which also removes the special-case legacy path. |
| 4 | MED | A′'s fallback crashes without a local `main`, and exits 1 without output when there are no changesets. | **Accepted.** Count the files first, always pass `--since=origin/main`, and treat any other failure as fatal. A′ moved into the cutover PR (§3). |
| 5 | MED-HIGH | No tag rulesets exist, so `contents: write` in the tag job can push int branches and move `v0.0.67`. | **Accepted.** The tag job runs no code and does no checkout; outputs are declared; a JP tag ruleset is a precondition (§5, D-3). |
| 6 | MED | The resume rule "attested commit == HEAD" wedges on a new push, a partial publish, or a rejected bot push. | **Accepted.** Commit and tag first, then publish idempotently per package (PR 6, §11). |
| 7 | MED | `check-docs` never checks anchors, and promotion can steal an older entry's slug. | **Accepted.** `--check` validates anchors with `github-slugger` and refuses colliding H3 slugs (§4). |
| 8 | MED | A reused or relanded slug picks up a stale label. | **Accepted.** The slug-continuity rule (§4). |
| 9 | MED | The tag-dependent lints are inert in CI (depth 1); stable and ship need tags. | **Accepted.** `fetch-depth: 0` for the lint job, prerelease and stable (PRs 2, 3, 6). |
| 10 | MED | Grandfathered legacy entries keep the relabel, miss the handoff, and move the budget. | **Accepted in part.** Grandfather the changeset requirement only; refuse new `next` labels. This departs from the brief, so it is **D-6**, with a ratchet as the fallback (§8). |
| 11 | MED | `extends` cannot target a legacy or released entry, which the cutover itself needs. | **Accepted.** `legacy#` and `released#` targets render as "continued" entries (§4). |
| 12 | MED | The budget relief was overstated: only 16 of 43 merges changed just this entry. | **Accepted.** I restated it as about a third of budget-file writes (§1, §7.3). |
| 13 | MED | Lockfile, workspace-override and build-script changes alter shipped bundles with no changeset required. | **Accepted.** Root-file rule in the gate (§7.1). |
| 14 | LOW-MED | Labels are undefined at promote time, and an unchecked `[skip ci]` promote can land. | **Accepted.** Such a file is labelled with the release version, and `lint:docs` + `--check` run inside the stable job (§5). |
| 15 | LOW | PR ordering: A′ before any changeset exists; README pointing at an empty "New since"; missing direct `@changesets/parse` dep, tag ruleset and deep fetch; precondition blocking `release/*`. | **Accepted.** Reordered: cutover is PR 4, ship is PR 5, A′ is in PR 4. Added the deps, the ruleset, the fetch depth, and an `allow_stale_base` input (§10). |
| 16 | LOW | V9 diffs against the working tree; V8 also accepts a modified changeset; V18 also formats `add` output; the supply-chain closure is about 44 packages and runs in the privileged job. | **Accepted.** V8, V9, V18 and §11 are corrected. |

**Not adopted:** nothing was rejected outright. Finding 10's "drop grandfathering entirely" became
the narrower D-6(a), because the brief asked for grandfathering and the changeset requirement can
be grandfathered at no cost.
