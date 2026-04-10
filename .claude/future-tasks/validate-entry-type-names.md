# Validate entryTypes names against the schema at config time

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
