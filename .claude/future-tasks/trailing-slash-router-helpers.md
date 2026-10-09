---
priority: P3
adopters: BOTH
summary: >-
  `withTrailingSlash` has shipped; left: a thin router/href wrapper in `canopycms-next` for internal links on static exports. Cluster note: `seo-trailing-slash-default-from-withcanopy` and `trailing-slash-build-smoke` are the other open follow-ups of #366, applying the same rule to other surfaces
---
# Trailing-slash-safe router/href helpers for `deployedAs: 'static'`

## Priority: P3 [BOTH]

**Cluster note:** this file and [seo-trailing-slash-default-from-withcanopy.md](seo-trailing-slash-default-from-withcanopy.md),
[preview-src-trailing-slash.md](resolved/preview-src-trailing-slash.md) and
[trailing-slash-build-smoke.md](trailing-slash-build-smoke.md) are the follow-ups of PR #366, all
applying the same `withTrailingSlash` rule to different surfaces.

## What shipped

`withTrailingSlash(path)` (`utils/url-prefix.ts`, exported from `canopycms/server`) is the
isomorphic primitive. It leaves a dotted last segment unslashed, because Next's own `trailingSlash`
redirects treat that as a file; a site-link helper must follow the same rule. The editor's own API
calls and preview URLs are covered: `withCanopy` sets `env.CANOPY_TRAILING_SLASH`, which both read
through `readTrailingSlashEnv()` (`utils/url-prefix.ts`).

## What is left

A static export (`output: 'export'`) needs every internal link trailing-slash-consistent with how
the static host serves files (`/foo/index.html` wants `/foo/`), and Next's router does not
guarantee it in every navigation path. Adopters currently hand-build the wrapper (one built a path
helper module, a wrapped router hook and a custom ESLint rule; another a single function).

- A thin `useInternalHref` / router-wrapping helper in `canopycms-next` that applies
  `withTrailingSlash` to internal links, so adopters wanting strict enforcement do not hand-build it.
  The plain function stays the baseline.
- The custom ESLint rule is an adopter enforcement choice; document the pattern (wrap all internal
  navigation) as a recommendation rather than shipping it.

## Related

- [toc-heading-id-contract.md](toc-heading-id-contract.md): sibling case of a capability adopters
  built twice independently.
