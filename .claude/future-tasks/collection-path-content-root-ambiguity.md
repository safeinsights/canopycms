# [P3] `normalizeCollectionPath` cannot distinguish a prefix from a sub-collection named after the content root

Raised by the human review of
[PR #229](https://github.com/safeinsights/canopycms/pull/229#pullrequestreview-4938780868)
(finding #11), 2026-08-14. Not reachable today; filed because the failure mode is "mutates a
different collection", not "not found".

## The ambiguity

`packages/canopycms/src/schema/schema-store.ts:405` strips one leading
`"{contentRootName}/"` so the editor's content-root-prefixed logical paths resolve. With
`contentRoot: 'content'`:

- `content/posts` → `posts` — intended.
- `content/content` → `content`, which `updateCollectionInner` / `updateOrderInner` then
  match against `=== this.contentRootName` and treat as the **root** collection. A
  sub-collection literally named `content` is therefore addressed as the root.
- `content/content/x` → `content/x` → `x` — i.e. the function is **not idempotent** for the
  nested case, contrary to what its comment used to claim. (The comment is corrected; the
  behaviour is not.)

Every entry point calls it exactly once today, so only the direct
`content/content` collision is reachable at all, and only for that one naming choice.

## Fix direction

Strip-by-string-prefix cannot tell the two apart — the information is not in the path. The
real fix is for the editor to send an unambiguously-scoped value: either a branded
`ContentRelativePath` distinct from `LogicalPath`, or an explicit flag on the mutator inputs
saying whether the path is content-root-prefixed. Either makes the boundary total instead of
heuristic, and removes the "call exactly once" rule the comment now has to state.

Cheap interim alternative if that is too big: reject a collection named exactly
`contentRootName` at schema-validation time, which removes the collision by construction.
