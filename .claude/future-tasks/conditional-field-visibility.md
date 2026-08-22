# No conditional field visibility, so mutually-exclusive fields can only be signposted in labels

**Status:** Open. **Priority: P2.** Found 2026-08-20 reviewing the marketing site's
`int-official-content` branch (PR #80). Filed rather than fixed — this is new schema surface and
wants its own design pass.

## Problem

A field config has no way to say "show this only when another field has a given value". There is
no `showIf`, `visibleWhen`, `dependsOn` or equivalent anywhere in
`packages/canopycms/src/config/types.ts`, `packages/canopycms/src/entry-schema.ts`, or
`packages/canopycms/src/editor/FormRenderer.tsx`, and no `oneOf`/union field type either.

So when a block legitimately has two mutually-exclusive ways to be authored, the schema cannot
express it and the editor cannot enforce it. The rule ends up in prose, in the one place prose is
guaranteed to be read: the field label.

## The worked example

The marketing site's `comparisonPanels` block acquired a paired `rows[]` shape alongside its older
`left.items` / `right.items` lists. With no way to declare exclusivity, the schema says this:

```
name: 'rows',  label: "Paired rows (use INSTEAD of the panels' own item lists)"
name: 'left',  label: '✗ panel (traditional approach) — unpaired list; ignored when `rows` is set'
name: 'right', label: '✓ panel (SafeInsights) — unpaired list; ignored when `rows` is set'
```

An editor sees all three, can fill all three, and two of them are then silently discarded at render
time. Nothing validates it, nothing warns, and the only signal is a parenthetical in a label.

Their own comment names the second-order cost: they kept both shapes partly because reshaping
would have been lossy under **#29** (unknown keys dropped with no diagnostic), so a missing schema
feature in one place hardened a workaround in another.

*(The adopter is separately collapsing that block to a single shape, which removes this particular
instance. The package gap it exposed does not go away with it — the next adopter with a
variant-shaped block hits the same wall.)*

## Why this is worth real design and not a quick attribute

- **Where does it evaluate?** The editor form is client-side and reactive; `validateEntryData` is
  isomorphic and authoritative. A visibility rule that only hides a field in the UI is cosmetic —
  data can still arrive from `sync`, a hand edit, or an older schema. A rule that also validates
  changes the write boundary's contract.
- **What can it reference?** Sibling field within the same group is the cheap case. Cross-group or
  parent-scope references need a path language, and a path language needs a story for `list: true`
  items.
- **Hidden ≠ absent.** If a field is hidden because a sibling changed, does its stored value get
  cleared, kept, or ignored? Each answer produces a different class of surprise, and #29 means a
  kept-but-hidden value is currently invisible forever.
- **The narrower alternative may be better.** A discriminated `variant`/`oneOf` field type — pick
  one shape, get exactly that shape's fields — models "two ways to author this block" more honestly
  than N independent visibility predicates, and is far easier to validate. Consider designing that
  first and treating general conditional visibility as the larger, later feature.

## Prior art in the codebase

`defineFieldFragment`, `defineInlineFieldGroup` and `defineNestedFieldGroup` (all in
`entry-schema.ts`) are the existing composition primitives; whatever shape this takes should sit
alongside them rather than beside them. `BlockComponentRegistry`'s `ExtraProps` generic is the
precedent for extending a schema-level type without breaking existing literals.
