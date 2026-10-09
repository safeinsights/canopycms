---
priority: P2
adopters: BOTH
summary: >-
  The MDX code policy runs only at a CMS save, so content committed outside the CMS, or saved
  before the upgrade, can still run code in a build. Run `validateMarkdownSafety` in the production
  build's schema guard (`static/index.ts` `findInvalidEntries`), which would fail such a build.
  Needs JP's call: it can turn a green build red on upgrade
---
# Check the MDX code policy at build time

**Priority:** P2 [BOTH]. **Filed:** 2026-10-09, from the MDX trust-model work.

## Problem

`validateMarkdownSafety` (`validation/markdown-safety.ts`) runs in the editor and at the API's
write boundary. A production build re-validates every entry against its schema
(`findInvalidEntries` in `static/index.ts`, through `validateEntryData`), but not against this
policy. So a non-`executable` field holding code reaches the site's `evaluate` at build time when:

- it was committed outside the CMS;
- it was saved before the adopter upgraded;
- it was merged into a work branch from a base that held it.

CI builds of content branches run with the repo's secrets.

## Proposal

Have `findInvalidEntries` also run `validateMarkdownSafety(item.schema, item.format, data)`, and
report the result like any schema-invalid entry. The list items need their format; check that
`BuildScanItem` carries it.

## Decision needed

This fails a build that passes today when existing content breaks the policy. One option is to
warn for a release, then fail.
