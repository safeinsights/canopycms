# `listEntries` / `buildContentTree` always list the base branch in prod

## Priority: P2 [BOTH]

Split out of [listentries-acl-awareness.md](resolved/listentries-acl-awareness.md)
on 2026-08-14, found while wiring path-ACL enforcement into those two methods.
Not an ACL bug — a branch-resolution one, in the same two methods.

## The gap

`context.ts`'s `resolveSchemaContextImpl` resolves one branch for both batch
reads:

```ts
const defaultBranch =
  services.config.defaultActiveBranch ?? services.config.defaultBaseBranch ?? 'main'
```

and neither `listEntries` nor `buildContentTree` accepts a `branch` option —
unlike `read`/`readByUrlPath`, which both take one and thread it to the content
reader.

In `dev` that is usually fine: `services.refreshActiveBranch()` runs at the top
of `getContext()` and re-detects the git HEAD, so the default tracks whatever
branch the developer is on. In `prod` it is not: `refreshActiveBranch` returns
immediately unless `mode === 'dev'` (`services.ts:521-524`), so the resolved
branch is whatever config declares — the base branch — for every request, with
no way for a caller to ask for another.

## Why it matters

The editor's preview pane is an iframe onto the host app's own page URL. On a
deployed (`mode: 'prod'`, `deployedAs: 'server'`) editor, an **index** page —
`/blog`, `/case-studies`, a docs landing page, anything built from
`listEntries` or `buildContentTree` — renders from the base branch, while the
single-entry preview beside it reflects the branch being edited. An editor
adding a post on a branch sees it in its own preview and **not** in the index
listing, with nothing on screen explaining the difference.

Latent today only because neither adopter has deployed a prod editor yet.

## Options

1. **Add `branch?: string`** to both methods, threading through
   `resolveSchemaContext` (which currently memoizes a single branch per
   `getContext()` call — it would need keying by branch name). Matches
   `read`/`readByUrlPath`. Most useful, most work.
2. **Resolve the active branch from the request** the way the API layer does,
   so preview iframes get branch-correct listings without adopters passing
   anything. Bigger design question: the context has no request-scoped branch
   concept today.
3. **Document only** — what shipped on 2026-08-14. Both methods' JSDoc now
   states the pinning and points here.

## Acceptance

- An index page previewed on a non-base branch in a prod-shaped deployment
  lists that branch's entries.
- A test covering `listEntries` on a non-default branch (there is none today —
  every existing test runs against the default).

## Related

- [listentries-acl-awareness.md](resolved/listentries-acl-awareness.md) — the
  ACL half of the same two methods, resolved 2026-08-14
- [reference-resolution-branch-switch-stale.md](reference-resolution-branch-switch-stale.md)
  — same "branch switch not reflected in a derived read" family
