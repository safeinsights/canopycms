# `includeBody` never reaches the editor's live preview

**Status:** Open. **Priority: P2** — the embed case is the marquee use of a brand-new opt-in
flag, and in the editor it looks broken.

## What happens

`ReferenceFieldConfig.includeBody` (2026-08-21) makes a resolved reference carry its target's
body. The server honors it everywhere — `read()`, `readByUrlPath()`, `listEntries`,
`buildContentTree`. The editor's live preview does not.

`api/resolve-references.ts` takes `{ ids: string[] }` and nothing else. It has no idea which
*field* an id came from, so it cannot know whether that field asked to embed, and it calls
`buildResolvedReference(doc.data, meta)` with no body argument. `includeBody` appears in zero
files under `editor/` or `api/`.

Consequence: a shared CTA block with `includeBody: true` renders its prose on the published
site and renders nothing for it in live preview.

**It is inconsistent within a single editing session**, which is the confusing part. On entry
load the form value already holds the fully resolved object *including* the body, because the
editor's GET reads through `store.read()` and resolution defaults to on. So the prose shows.
The moment the user picks a different target, the field's value becomes an id string,
resolution goes through this endpoint instead, and the prose disappears until save + reload.

## Why it was not fixed alongside

It needs a wire-shape change to a public endpoint — the request has to carry `includeBody` per
id — plus a matching cache-key change on the client. That is worth its own review rather than
riding along with a fix for something else.

## Shape of the fix

- Extend the request body so each id can carry its flag. Either widen `ids` to accept
  `{ id, includeBody }` objects, or add a parallel `withBodyIds: string[]`; the former is
  cleaner, the latter is additive and cannot break an in-flight client.
- `resolveChangedReferences` (`editor/client-reference-resolver.ts`) already holds the
  `ReferenceFieldConfig` when it resolves, so it can send the flag without new plumbing.
- The endpoint has `flatSchema`, so it can resolve the target's body field name and pass a
  body argument to `buildResolvedReference`.
- **Give the client caches the same `includeBody` dimension the server cache has.** Keys are
  `${branch}:${id}` (`client-reference-resolver.ts`, and several places in
  `useReferenceResolution.ts`). The server keyed its resolve cache `${id}:body` for exactly
  this reason: two fields referencing one target with different flags must not share an entry,
  or traversal order decides the shape for both.

## Related

- [resolved-reference-shape.md](resolved/resolved-reference-shape.md) — added `includeBody`.
- The endpoint and the server resolver now share `buildResolvedReference`, so the *assembly*
  cannot drift; this is the remaining gap in the *inputs* to it.

[BOTH]
