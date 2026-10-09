---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-08, deferred from adopter request 85. Untouched body blocks keep their text and new text uses Prettier's markers, but an edited block is still MDXEditor's serialisation, whose escapes (`a\_b`) Prettier rewrites. Format edited blocks with `prettier/standalone` server-side inside the splice, with Prettier's defaults
---
# [P3] Format edited markdown blocks with Prettier

Found 2026-10-08, deferred from adopter request 85 by agreement with the adopter.

## The gap

A markdown body save now keeps every untouched block's text (`utils/markdown-body-splice.ts`), and
the editor writes new text with Prettier's markers (`editor/fields/markdown-export-options.ts`).
An EDITED block is still the editor's serialisation, which a `prettier --check` can reject:
MDXEditor escapes characters Prettier writes bare (`a\_b`, which Prettier rewrites to `a_b`;
measured with Prettier 3.8.1). Its tables are already padded as Prettier pads them. With `_`
emphasis, intraword emphasis (`foo*bar*baz`) comes out as character references
(`fo&#x6F;_&#x62;a&#x72;_&#x62;az`), which Prettier accepts but nobody can read. The adopter that
reported 85 said this is not needed for them.

## Proposal

Run `prettier/standalone` with its markdown plugin over each edited block, server-side, inside the
splice: format the block with its neighbours and keep only its slice (Prettier alternates bullets
between adjacent lists and numbers ordered lists from the original). Keep the splice's self-check,
so a Prettier change of meaning falls back to the unformatted block. Use Prettier's defaults rather
than reading the adopter's `.prettierrc`; the adopter preferred an explicit config option, if any,
over discovery. Prettier becomes a runtime dependency of the server path; its MDX support predates
MDX 2, so mdx bodies are best-effort.
