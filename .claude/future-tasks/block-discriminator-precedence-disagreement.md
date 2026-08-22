# The two block-discriminator readers disagree on precedence

**Status:** Open. **Priority: P3.** Found 2026-08-22 while fixing comment misattachment on list
edits in `utils/content-serialize.ts` (branch `fix/comment-misattachment-on-list-edit`).
**Pre-existing** — that branch does not change either reader.

## Problem

A block item is identified by a discriminator naming its template. Two shapes are accepted: the
canonical `{ template: 'hero', value: {...} }` that the editor writes and `ContentStore`
persists, and a defensive inline `{ _type: 'hero', ...fields }`.

Two places read that discriminator, and they prefer opposite keys:

- `packages/canopycms/src/validation/field-traversal.ts` — `resolveBlockItem` tries
  `item.template` first, then `item._type`.
- `packages/canopycms/src/ai/json-to-markdown.ts:547` — `blockItem._type || blockItem.template`.

So an item carrying **both** keys resolves to one template when validated and a different one
when rendered into the AI content bundle. Nothing detects the divergence; the AI bundle just
describes the entry using the wrong template's fields and labels.

The `||` in the AI path has a second, smaller issue: it falls through on any falsy value, so
`_type: ''` silently defers to `template`, whereas `resolveBlockItem`'s `typeof === 'string'`
test accepts `''` and then fails to find a template. Different outcomes for the same input.

## Why it was left alone

Reconciling it is a **behaviour** decision, not a refactor — whichever precedence loses changes
what some existing content resolves to — and the fix that surfaced it was a deliberately narrow
one in a module written to protect editorial comments.

## Suggested resolution

`packages/canopycms/src/validation/block-structural-keys.ts` now exists as the single home for
which keys are discriminators (`BLOCK_DISCRIMINATOR_KEYS`, ordered in `resolveBlockItem`'s
precedence). Both readers should iterate that ordered list instead of spelling the keys out, so
precedence is defined once:

1. Point `resolveBlockItem` at `BLOCK_DISCRIMINATOR_KEYS` (behaviour-identical today).
2. Point `json-to-markdown.ts` at it too (this is the behaviour change — canonical `template`
   would start winning over `_type`), using a `typeof === 'string'` test rather than `||`.
3. Add a test for an item carrying both keys, asserting the two paths agree.

Worth checking first whether any real content carries both keys; if none does, step 2 is a
no-op in practice and the change is cheap.

## Related

- `packages/canopycms/src/validation/block-structural-keys.ts` — the shared list, and the doc
  comment that points here.
- `packages/canopycms/src/utils/content-serialize.ts` — `looksLikeSameItem`, the caller that
  needed the keys excluded from identity evidence.
