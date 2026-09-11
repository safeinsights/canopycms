# `validation/` — Validation

Schema-driven validation, and the single field-traversal encoding everything else is meant to build on.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
418 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

Validation utilities (field traversal, reference validation, entry link validation, pure isomorphic entry schema validation in `entry-validator.ts` shared by the editor and the authoritative server write boundary)

`field-traversal.ts`'s `traverseFields` is THE single encoding of the schema-nesting rules (group transparent, object/object-list nested, block templates via `resolveBlockItem`) — add to it rather than writing another walker, and note its optional `onContainer` hook, which reports each (record, governing fields) pair and is what lets a check look at the DATA's own keys; an inline group deliberately does NOT fire that hook, because it re-enters the walk with the same record and would otherwise make every sibling of the group read as an unknown key.

### `entry-validator.ts` — unknown-key reporting

`entry-validator.ts`'s `findUnknownKeys` is built on `traverseFields` and reports content keys the schema does not define — non-blocking, feeding `validationWarnings` at the API boundary and `static/`'s `warnUnknownEntryKeys` at build time; it runs on the NORMALIZED (about-to-be-persisted) data, so a resolved reference collapsed to an id string can't be mistaken for anything, and it reports nothing when a container has no fields at all ("no schema" is not "every key is unknown").

### `normalizeReferenceValues` — the inverse of reference resolution

`normalizeReferenceValues(fields, data)` is the inverse of resolution: it collapses resolved reference objects (`{ id, ... }`) back to their id strings, recursing through objects/lists/block items. `api/content.ts`'s write handler runs it on the incoming payload BEFORE both validating (so `ReferenceValidator` checks the real id, not a stale resolved snapshot from a prior GET) and persisting — the editor round-trips whole documents, so an unnormalized save would freeze a `{ ...target data, id, slug, collection, urlPath }` snapshot into the content file and permanently sever the reference from its target; `findUnknownKeys` then runs on that same normalized data for exactly this reason. `entry-type-reference-validator.ts` checks every reference field's `entryTypes` against the resolved schema's actual entry types (typo detection), wired into `branch-schema-cache.ts` before caching.

### `block-structural-keys.ts` — one list, two opposite consumers

`block-structural-keys.ts` is the dependency-free single home for the block discriminator keys (`template`, `_type`) — `BLOCK_DISCRIMINATOR_KEYS` ordered in `resolveBlockItem`'s precedence, plus the `BLOCK_STRUCTURAL_KEYS`/`isBlockStructuralKey` membership form. Two callers need the SAME list for opposite-looking reasons and must not drift: `findUnknownKeys` must not report a discriminator as a stale key, and `utils/content-serialize.ts`'s `looksLikeSameItem` must not accept one as evidence that two list items are the same item — counting it migrated an editorial comment off a deleted block onto an unrelated survivor, since every `hero` carries `template: hero`. NOTE the two remaining readers still spell the keys out because they read the VALUE positionally, and they disagree on precedence (`resolveBlockItem` prefers `template`, `ai/json-to-markdown.ts` prefers `_type`) — see `.claude/future-tasks/block-discriminator-precedence-disagreement.md`
