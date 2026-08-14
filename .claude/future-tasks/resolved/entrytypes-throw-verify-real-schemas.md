# Verify the entryTypes hard-error against real adopter schemas before it reaches a live site

## Priority: P2

Action item from `fix/adopter-config-correctness` (PR #190, merged 2026-08-12). JP
approved the throw as a design decision; this is the verification step that decision
implies, which is a separate piece of work and was not done in that PR.

## What changed

`validation/entry-type-reference-validator.ts` now runs during schema resolution
(`branch-schema-cache.ts`'s `resolveFreshAndPersist`, right after `isValidSchema` and
before anything is cached). A reference field whose `entryTypes` names an entry type
that does not exist anywhere in the resolved schema **throws**.

Warning was considered and rejected: a silent empty picker is the exact failure the fix
removes, and throwing is consistent with the adjacent `isValidSchema` throw. That
remains the right call.

## Why this needs verifying

The blast radius is a whole branch, not one field. The check runs on every schema
resolution for that branch and throws before the cache is populated, so a single stale
or misspelled `entryTypes` value makes that branch fail on **every** request until the
`.collection.json` is corrected. That is intended — but it means an adopter who has
been living with a silent typo gets a hard failure the moment they upgrade, with no
staged warning period.

We are about to become that adopter.

## Do this

1. Run the validator against **docs-site-proto**'s real content, and against
   `apps/example1`, before the version carrying this change is deployed to a live site.
   Cheapest path: check out the content and resolve the schema (any `getSchema` call
   through `BranchSchemaCache` exercises it), or call
   `validateReferenceEntryTypes(resolvedSchema)` directly — it is pure and takes only a
   `RootCollectionConfig`.
2. If anything trips, fix the `.collection.json` typo — do not soften the check.
3. If several real schemas trip, that is evidence the silent-failure mode was more
   widespread than assumed. Reconsider whether a one-release warning period is
   warranted before the throw, and say so on the program log.

Sequencing: must happen before Workstream E (first real CMS deployment for
docs-site-proto) puts this code in front of the teams' live docs site.

## Related

- [resolved/validate-entry-type-names.md](validate-entry-type-names.md) — the
  implementation and why the check lives at schema resolution rather than config time
- [validate-collection-names.md](../validate-collection-names.md) — the sibling
  `collections` check is still unvalidated; if it is added with the same throw
  semantics, it needs this same verification pass
