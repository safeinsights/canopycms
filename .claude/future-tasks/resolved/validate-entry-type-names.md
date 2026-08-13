# Validate entryTypes names against the schema at config time

## RESOLVED — 2026-08-12 (`fix/adopter-config-correctness`)

`validation/entry-type-reference-validator.ts` collects every entry type name in
the resolved schema and checks each reference field's `entryTypes` against it,
reporting the field name, its collection/entry-type location, a closest-match
"Did you mean …?" suggestion, and the list of known names.

Correction to the "Considerations" note below: this could **not** go in
`ensureReferenceFieldsHaveScope`. That runs at entry-schema *registration*
(`entry-schema-registry.ts`), before any branch schema exists, and entry types
are declared per-branch in `.collection.json` files on disk. So the check runs
after schema resolution instead — in `branch-schema-cache.ts`, next to the
existing `isValidSchema` throw and before anything is persisted, so a typo fails
loudly and consistently rather than being cached.

The shared schema-only reference-field walk was factored out of
`ensureReferenceFieldsHaveScope` as `forEachReferenceField` in
`config/validation.ts` and is used by both. (`validation/field-traversal.ts`'s
`findFieldsByType` does not fit: it walks a schema alongside concrete entry
data, which does not exist at this point.)

**Still open:** validating `collections` names the same way — the last line of
this file. Worth doing, same mechanism, not done here to keep the change small.

## Problem

When a reference field specifies `entryTypes: ['partner']`, there is no check that `'partner'` is actually a valid entry type name defined in the schema. If an adopter misspells the name (e.g., `entryTypes: ['parter']`), they get zero results silently — no error, no warning.

This is the same behavior as misspelling a collection name in `collections`, so it's not a regression. But since `entryTypes` is a new feature, it's a good time to consider adding validation.

## Desired behavior

At config/schema load time, validate that all `entryTypes` values in reference fields match actual entry type names defined somewhere in the schema. Emit a clear error if not:

```
Error: Reference field "partners" specifies entryType "parter" which does not exist in any collection.
Did you mean "partner"?
```

## Considerations

- Entry types are defined per-collection in `.collection.json` files, not globally. The same entry type name can appear in multiple collections. Validation would need to scan all collections to build the set of known entry type names.
- This could be done in `ensureReferenceFieldsHaveScope` in `config/validation.ts`, or as a separate validation pass after schema loading when the full flat schema is available.
- The same approach could also validate `collections` names, which currently also fail silently.
