# Saving an entry with a dangling reference replaces the ID with `null`

**Status:** Open. **Priority: P2** — silent, irreversible loss of which entry was referenced,
on a path an editor reaches without doing anything unusual.

## What happens

`store.read()` resolves a reference whose target is missing or deleted to `null`
(`content-store.ts`, `resolveSingleReferenceOnce`). The editor's GET reads with resolution on,
so its form state holds `null` for that field. On save, `normalizeReferenceValues` skips `null`
(`validation/entry-validator.ts`, the `value === undefined || value === null` guard), so `null`
is what gets persisted — **over the ID string that was in the file**.

Verified end to end against a real store.

For an *optional* reference this is silent: the save succeeds and the record of which entry was
referenced is gone. For a *required* one the entry becomes unsavable until the field is cleared
and re-picked, which is at least loud.

Note the deletion path is a normal one: delete or rename a target, open a referencing entry,
save it for an unrelated reason, and the reference is destroyed rather than merely broken.

## Relationship to the severed-reference fix

Separate, and NOT fixed by it. Normalizing at the write boundary
(`.claude/future-tasks/resolved/resolved-reference-shape.md`) stopped a *resolved* reference
being frozen into the file. This is the opposite case: an *unresolvable* one, where there is no
object to collapse and the id has already been replaced by `null` before the payload is built.
Open-and-save is lossless only when every reference resolves.

## Shape of the fix

The information is lost upstream, in resolution, so the write boundary cannot recover it — by
then the id is gone. Options, in rough order of preference:

1. **Resolve a dangling reference to a tombstone that keeps the id** — e.g.
   `{ id, exists: false }` — so `referenceValueId` recovers the id on save and the reference
   survives as broken-but-identified. Requires deciding the tombstone's shape against
   `ResolvedReferenceMeta` and the `| null` in `TypeFromEntrySchema`, and auditing consumers
   that currently test `=== null`.
2. Have the editor preserve the pre-resolution id alongside the resolved value, and post that.
   Keeps the wire shape but puts the invariant in the client, where it is easy to lose again.
3. Surface it as a validation warning on read (`validationWarnings` already exists end to end)
   so the editor can tell the user before they save over it. Mitigation, not a fix — pairs well
   with 1.

Option 1 also improves the read side: a page rendering a broken reference currently cannot say
*which* entry is missing, which makes content repair harder than it needs to be.

## Related

- [resolved-reference-shape.md](resolved/resolved-reference-shape.md) — the write-boundary
  normalization this sits beside.
- [reference-resolution-bypasses-path-acls.md](reference-resolution-bypasses-path-acls.md) —
  note an ACL-denied target could produce the same `null` if resolution ever starts filtering,
  so decide the tombstone shape with that in mind.

[BOTH]
