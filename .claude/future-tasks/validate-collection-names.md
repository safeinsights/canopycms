---
priority: P2
adopters: KB
summary: >-
  Reference fields' `collections` values are still unvalidated (silently zero results on a typo); the sibling `entryTypes` check shipped 2026-08-12 — reuse `forEachReferenceField` (`config/validation.ts:68-87`) + the branch-schema-cache hook. **Promoted P3→P2**: all five reference fields in the KB's schemas use `collections` today, so a typo fails silently in the KB right now
---
# Validate reference fields' `collections` names against the schema

## Priority: P2

Spun out of [validate-entry-type-names.md](resolved/validate-entry-type-names.md)
when that shipped on `fix/adopter-config-correctness` (2026-08-12).

## Problem

A reference field's `entryTypes` values are now validated against the resolved
schema — a misspelling fails at schema resolution with a clear error and a
"Did you mean …?" suggestion.

Its sibling scope, `collections`, is **not** validated. A reference field with
`collections: ['postts']` still resolves silently and returns zero options at
runtime, which is exactly the confusing failure the entryTypes work removed.

## Fix

The mechanism already exists and should be reused, not rebuilt:

- `validation/entry-type-reference-validator.ts` — `validateReferenceEntryTypes`
  is the model. Add the collections check alongside it (same module, or a
  sibling that shares the traversal).
- `forEachReferenceField` in `config/validation.ts` — the schema-only walk over
  reference fields, including `group`/`object` fields and `block` templates.
- Wire into the same place: `branch-schema-cache.ts`'s `resolveFreshAndPersist`,
  next to the existing `isValidSchema` throw and before anything is cached.

The set of valid collection paths comes from the same collection-tree walk
`collectEntryTypeNames` already does — note that `collections` values are
logical *paths* (e.g. `posts`, `docs/api`), not bare names, so the comparison
set differs from the entry-type one even though the traversal is shared.

## Note on blast radius

Same tradeoff that was settled for entryTypes: this throws at schema resolution,
so a typo takes the branch down until fixed. That was accepted deliberately —
it is consistent with the adjacent `isValidSchema` throw and surfaces the
mistake immediately — but it is worth re-confirming against docs-site-proto's
real schema before landing, since `collections` is the older and more widely
used of the two scopes.
