# Document reusable field fragments (works today, undocumented)

## RESOLVED (2026-08-14, branch `feat/block-registry-types-and-recipes`, `integration-202608-b` epic)

Documented as scoped below: README gained a "Reusable Field Fragments" section (under
Page Blocks) covering both mechanisms — spreading a `const`-inferred field array, and
nesting `defineInlineFieldGroup` inside a block template — plus a worked example of a
per-use override (spread everything except the one field that differs, override just
that field from the same underlying const). A 3-line `defineFieldFragment()`
const-inference identity helper was added beside `defineBlockTemplate` for
discoverability, with tests in `entry-schema.test.ts`. See
`docs/adopter-migration.md`'s "Unreleased" section for the adopter-facing entry.

## Priority: P3 [BOTH]

From adopter request #15 in `../website/docs/canopycms-requests.md`
("reusable field fragments"), triaged during the 2026-08-14 go-live backlog
re-baseline. **This epic (`integration-202608-b`, PR #235) is documenting this
now** — don't double-build.

## What already works

No new package code needed — this is a pure documentation gap. Two patterns
already compose the way the request wants:

1. **Spread a `const`-inferred field tuple** into `fields`. Both
   `defineEntrySchema` and `defineBlockTemplate` use `const T extends …`
   generics, so a `const sharedFields = [...] as const` spread into multiple
   schemas' `fields` arrays type-checks and works today.
2. **Nest `defineInlineFieldGroup`** (`entry-schema.ts:189-198`) inside a block
   template. Inline groups are transparent all the way down the stack — type
   level (`FlattenInlineGroups`, `entry-schema.ts:24-31`), data level
   (`utils/flatten-group-fields.ts`), validation
   (`validation/entry-validator.ts:227,355`), reference resolution
   (`content-store.ts:1611-1617`), and the editor (`BlockField.tsx:239`).

## Action

Add a README section (near the block-template / field-group docs) showing
both patterns with a short example each, so adopters don't have to rediscover
`const`-generics composition or inline-group nesting by reading the source.
No code changes.
