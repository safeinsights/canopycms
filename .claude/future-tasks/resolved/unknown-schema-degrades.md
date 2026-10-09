---
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/unknown-schema-degrades`, base `int-202610-b`, adopter request 96b. In a branch workspace, a `.collection.json` naming an entry schema the running code's registry lacks marks only that entry type `unavailable`. Its entries cannot be read for editing, written, created, renamed or deleted (a retriable 503, `code: 'SCHEMA_UNAVAILABLE'`). The navigator, the entry pane and System health say so, and the rest of the branch works. A build, static deploy or `generate-ai-content` still fails. Schema snapshots now carry a registry fingerprint, so a deploy re-resolves them.
---

# One unknown schema reference takes the whole editor down

**RESOLVED 2026-10-09**, branch `fix/unknown-schema-degrades`, base `int-202610-b` (adopter
request 96b; 96a, gating the worker's sync on the running editor's registry, is a separate
decision).

## Problem

A website merge added an entry schema to the code's registry and content whose `.collection.json`
named it. The worker synced the content into the editor's base branch while the editor still ran
the previous image, and every `/edit` request answered 500 ("Schema reference … not found in
registry") until the new image deployed, 14 minutes later. A deploy takes about as long as one
sync interval, so a merge that adds or renames a schema can meet the old image either way round.
A reference field in the new image scoped to an entry type the old content lacks fails the same
way.

## Resolution

- `BranchSchemaCache` owns the split. Content read from the checkout (a build, a static deploy)
  shares a commit with the code, so both mismatches throw there, and `generate-ai-content` fails
  on any issue. In a branch workspace the entry
  type stays in the schema with `schema: []` and `unavailable`, the reference mismatch only
  empties that field's options, and both are returned as `issues` and logged once per process.
- `ContentStore` refuses every mutation of an unavailable entry type, and a read for editing.
  Reference resolution still reads it raw, so healthy entries that point at it keep working, and
  a delete's reference scan counts any string in its data equal to the target id. The API answers
  with a 503 and `Retry-After: 60`. Adopter listings and AI content leave such entries out, and an
  adopter read of one is a not-found.
- The editor shows the message in the navigator and in place of the form, with no create, save,
  menu or preview for it; drafts are kept. System health lists the issues.
- Pre-existing, fixed with it: schema snapshots were fresh by generation marker alone, and a
  deploy bumps none, so a new image kept validating saves against the old image's fields until a
  git operation. Snapshots now carry the registry's fingerprint.
