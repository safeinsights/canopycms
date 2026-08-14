# Trailing-slash-safe router/href helpers for `deployedAs: 'static'`

## Priority: P2 [BOTH]

From the 2026-08-13/14 site audits of `../docs-site-proto` and `../website`,
triaged as part of the 2026-08-14 go-live backlog re-baseline. No existing
task file covered this.

## Both sites solved this independently, at very different weight

A static export (`output: 'export'`, CanopyCMS's `deployedAs: 'static'`
shape) typically needs every internal link to be trailing-slash-consistent
with how the static host serves files (`/foo/index.html` wants `/foo/`, not
`/foo`), and Next's own router doesn't guarantee this for you automatically
in every navigation path.

- `docs-site-proto` built a whole subsystem: `paths.ts` +
  `use-internal-router.ts` (a wrapped router hook) + a **custom ESLint rule**
  to catch raw `<a href>`/`router.push` calls that skip the wrapper.
- `website` built one function: `withTrailingSlash()`.

Neither is wrong, but the gap between "a whole enforced subsystem with a
custom lint rule" and "one helper function" for the *same underlying need*
suggests the primitive belongs in the package, with adopters choosing how
strictly to enforce it.

## Proposed solution

- Ship a `withTrailingSlash(path)` (or equivalent) URL helper in the
  framework-agnostic path utilities, isomorphic (no `node:` imports — must
  stay `pnpm lint:bundle`-clean since it's link-rendering code, inherently
  client-reachable).
- Consider a thin `useInternalHref`/router-wrapping helper for
  `canopycms-next` that applies it automatically for internal links, so
  adopters who want the KB's stricter guarantee don't have to hand-build
  `use-internal-router.ts` themselves — but keep the plain helper as the
  baseline so `website`'s lighter-weight usage stays simple.
- The custom ESLint rule is a KB-specific enforcement choice, not necessarily
  something to ship from the package — document the pattern (wrap all
  internal navigation) as a recommendation instead.

## Related

- Trailing-slash routing is listed in the capabilities-both-sites-built table
  from the go-live briefing alongside search index, sitemap+SEO, and heading
  annotation — all independently-built-twice capabilities from the same
  audit pass. See [toc-heading-id-contract.md](toc-heading-id-contract.md)
  for the sibling case.
