---
priority: P2
adopters: BOTH
summary: >-
  A production build warns about entries holding code in a non-`executable` markdown or MDX field
  (`warnUnsafeMarkdown` in `static/index.ts`), but still renders them, so a site that `evaluate`s
  them runs that code on CI. Decide when the warning becomes a build failure. JP's call: it turns a
  green build red for content the save path deliberately keeps
---
# Fail the build on code in a non-executable markdown or MDX field

**Priority:** P2 [BOTH]. **Filed:** 2026-10-09, from the MDX trust-model work.

## Where things stand

The save path refuses any code a save adds to a field that is not `executable`, but keeps code the
stored entry already held, with a warning, so no author is stuck
(`splitByStored` in `validation/markdown-safety.ts`). That kept code came from outside the CMS, or
from before the upgrade. A production build lists every entry holding some (`warnUnsafeMarkdown`),
but renders it anyway. CI builds of content branches run with the repo's secrets.

## Proposal

After adopters have had a release to clean up, make the build fail instead of warn. Run the scan
in `assertBuildEntriesValid` instead of beside it, or behind a config switch like
`danglingReferences`.

## Decision needed

When the warning becomes an error, and whether a switch keeps it a warning for a site that needs
longer.
