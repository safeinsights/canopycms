# One blessed markdown renderer — decided NOT to build

## Priority: P3 [BOTH]

From adopter request #18 in `../website/docs/canopycms-requests.md` ("one
blessed markdown path"), triaged during the 2026-08-14 go-live backlog
re-baseline.

## Decision: not building — do not relitigate without new information

Recorded here so this doesn't get re-proposed and re-analyzed from scratch.
Reasons, in order of weight:

1. **Forces a runtime dependency and a client-bundle cost onto every
   adopter.** A blessed renderer means adding `react-markdown` + `remark-gfm`
   + a sanitizer as runtime deps to the package.
2. **The RSC default-export trap makes it worse.** `react-markdown` must be
   used as `'use client'` to dodge a React Server Components default-export
   gotcha, which means every adopter's markdown fields would be forced into
   the client bundle — even adopters doing pure static builds with no editor
   code shipped (deploy shape (a) in AGENTS.md).
3. **It still wouldn't solve the problem.** The request is driven by two
   sites' divergent MDX rendering pipelines (`docs-site-proto`:
   `evaluate-mdx` + `DocPage`/`DocView` + `mdx-render-check`; `website`: two
   separate pipelines), and a plain-markdown renderer covers none of the MDX
   half — which is the half that's actually diverging.
4. **The divergence is site policy, not CMS policy.** Two sites choosing
   different presentation layers for their MDX content isn't a defect in
   CanopyCMS; forcing one renderer removes a degree of freedom adopters
   legitimately want (docs sites and marketing sites render markdown
   differently on purpose — different component mappings, different
   sanitization needs).

## The actionable remainder

What's real and worth doing: **document the trap**, since nothing today warns
an adopter who reaches for `react-markdown` themselves. `grep react-markdown
README.md` is currently empty. Add a short README note (near the markdown
field docs) explaining:

- Why `react-markdown` needs `'use client'` in an RSC tree, and what that
  costs (client bundle size, no server-only optimizations for that subtree).
- That CanopyCMS doesn't ship an opinionated renderer on purpose, and points
  at the two in-repo examples (`docs-site-proto`'s `evaluate-mdx` pipeline,
  `apps/example1`'s markdown handling) as reference shapes rather than
  prescriptions.

## Related

- [search-document-extraction-primitives.md](resolved/search-document-extraction-primitives.md)
  — same shape of decision (ship the shared primitive underneath, not an
  opinionated top-level API).
