# `extractToc()` + a stable heading-ID contract

## Priority: P2 [BOTH]

From the 2026-08-13/14 adopter site audits, triaged as part of the
2026-08-14 go-live backlog re-baseline. No existing task file covered this.

## Both sites built the same thing independently, and one copy is broken

Both sites independently wrote their own heading-attrs rehype pass to stamp
stable `id`s onto rendered headings — a real, converged signal that this
belongs in the package, not adopter code.

The marketing site went further and layered a TOC-extraction module on top
to pull a table of contents from the annotated headings, but it
**hand-mirrors rehype-slug's dedup counter** (the "if this slug already
exists, append `-1`, `-2`, …"
logic) instead of sharing state with whatever actually assigned the IDs. The
two counters are two independent pieces of state tracking the same thing, and
they **desync the first time an author writes a heading containing `#` or
`####`** (i.e., a literal hash character in heading text, which
rehype's slugger and a hand-rolled mirror can tokenize differently) — the TOC
then links to an anchor ID that doesn't match the heading's actual rendered
`id`, silently breaking in-page navigation.

## Proposed solution

- Ship `rehype-heading-attrs` (or equivalent) as a package-level rehype
  plugin, so both sites (and future adopters) get one canonical
  heading-ID assignment instead of two independently maintained copies.
- Ship `extractToc()` as a companion that reads the *same* ID-assignment pass
  the rendering plugin used — not a second slugger — so TOC and rendered
  anchors can never desync by construction.
- Document the heading-ID contract explicitly (stable across rerenders,
  collision-handling rule) so an adopter who wants to link to
  `#some-heading` from outside the rendered page has something to rely on.

## Acceptance

- A regression test with a heading containing a literal `#`/`####` character
  and a duplicate heading text, asserting the TOC's `href` matches the
  rendered heading's `id` exactly.
