---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-08. An adopter's site name appears in two dozen backlog files, and its live docs hostname in four; the account ids and stack names are already gone. Decide whether the site name counts as private, then scrub to role wording; a name-list guard would need its list kept outside the repo. JP's call
---
# The public repo names an adopter's site and its live docs hostname

**Status:** Open. **Priority: P3.** Filed 2026-10-08, split out of
[public-repo-account-id-and-adopter-names.md](resolved/public-repo-account-id-and-adopter-names.md),
which removed account ids and stack names but left these.

## State

This repository is public; the adopter site repos are private. One adopter's site (repo)
name appears in two dozen tracked files, all of them backlog records:

- `BACKLOG.md` and `.claude/future-tasks/index.md`
- open tasks: `adopt-changesets.md`, `adopter-image-field-migration.md`,
  `baseline-2026-08-implementation-followups.md`, `docs-site-assets-wiring.md`,
  `entry-create-modal-no-entry-types-deadend.md`, `entry-navigator-scalability.md`,
  `production-readiness-program.md`, `program-log.md`, `schema-faq-glossary.md`,
  `validate-collection-names.md`
- resolved records: `assets-media-system.md`, `deploy-image-build-smoke-test.md`,
  `dual-react-problem.md`, `entrytypes-throw-verify-real-schemas.md`, `link-by-entry.md`,
  `program-a-release-path.md`, `program-e-docs-site-cms.md`, `program-f-production.md`,
  `readbyurlpath-collection-url-support.md`, `readbyurlpath-entry-type.md`,
  `stale-draft-prevents-content-load.md`, `static-export-sitemap.md`

The adopter's live docs hostname appears at `production-readiness-program.md:70,85`,
`program-log.md:68`, `resolved/program-d-stack-rebuild.md:36` and
`resolved/program-e-docs-site-cms.md:21,97`. `program-log.md:76` and
`resolved/program-f-production.md:40` also cite a path in a private infrastructure repo, and
`stray-init-remotes-accumulate.md:35-36` paste absolute paths under a maintainer's home
directory.

## Proposal

Decide first whether the site name counts as private: it is the adopter's repo name, and
much of the program record is about that site, so a scrub is judgment-heavy rather than
mechanical. If it does, replace each with role wording ("the docs site", "the teams' live
docs host"), keep the technical content, and consider a name list in a guard like
`scripts/check-account-ids.mjs`. A name list can only live outside the repo, which is the
open design question. JP's call.
