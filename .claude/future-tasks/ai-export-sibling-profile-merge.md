# Give AI-export transforms a way to fold in a colocated sibling artifact

## Status: SHIPPED (entry transforms)

Shipped as **entry transforms** in `packages/canopycms/src/ai/`. The AI config gains an
`entryTransforms?: Record<entryType, EntryTransformFn>` hook:

```ts
type EntryTransformFn = (
  entry: AIEntry,
  ctx: { contentId: string; readSibling: (name: string) => Promise<string | null> },
) => Promise<string | undefined> | string | undefined
```

- Runs **once per entry** at generation time (`runEntryTransform` in `generate.ts`), may be async.
- Returns markdown to **append** after the entry's body/fields; `undefined` appends nothing
  (append-only — `entryToMarkdown` remains the sole owner of base serialization).
- The cached result (`AIEntry.appendedSections`) flows into the per-entry file, the collection
  `all.md`, **and** bundles automatically — no post-hoc string surgery, and the file IO runs once.
- Fires for **every format**, including data-only JSON/YAML entries (where `bodyTransforms` never
  fired) — which is exactly the `dataset` case.

### Why `readSibling` instead of a raw source path

The exporter's output is published to the web, and `context.ts` warns that the entry's absolute
`physicalPath` must not leak into public output. So instead of handing the transform a raw path,
Canopy provides a directory-bound, traversal-guarded `readSibling(name)`:

- Rejects slashes, `..`, and absolute paths; reads only a bare filename in the entry's own dir.
- Resolves `null` for a missing file or non-regular file.
- Path-safety and IO stay inside the package; the absolute path is never exposed.

`ctx.contentId` is the stable Base58 ID embedded in the entry filename (invariant under slug edits),
so adopters can name siblings as `<contentId>.profile.json` — the same key the render path uses via
`meta.physicalPath`. This makes the AI exporter symmetric with the already-blessed colocated-artifact
read capability that page renderers use.

### Design boundary: per-entry isolation

A transform sees one entry plus its colocated sibling *files* — not other *entries*. Cross-entry
context (e.g. an index of all table-ids → pages for resolving FK links between datasets) stays
adopter-side. This is intentional; a cross-entry "finalize" phase would be a separate, larger feature.

## Remaining (adopter-side, docs-site-proto)

docs-site-proto can now delete `scripts/inject-profile-schema.ts` and its
`&& node scripts/inject-profile-schema.ts` from `build:ai`, and instead call its own
`renderDatasetSchemaMarkdown(merged, raw)` from an `entryTransforms.dataset` that resolves
`<contentId>.profile.json` via `readSibling`. A small cross-entry enumeration (the FK target index)
legitimately survives adopter-side; all the IO, merge, and `all.md` string-surgery goes away.

## Considered but deferred: first-class "sibling-artifact" content concept

A higher-altitude alternative — Canopy declaring sibling artifacts in the schema and
auto-discovering/loading/merging them into `entry.data` everywhere (render + AI + JSON-LD) — was
considered and **deferred**. It is premature for one adopter and one sibling type, and it raises
unresolved questions (does the editor surface it? is it schema-validated? what happens on
save/publish/branch sync?). The merge itself (`mergeProfileWithAnnotations`) and the rendering
(`renderDatasetSchemaMarkdown`) are adopter domain logic Canopy should not own regardless. Revisit
only with >1 adopter/sibling-type and a resolution of the editor/validation/branch semantics.

## Related

Relates to `ai-content-v2.md` and `readbyurlpath-entry-type.md` (same theme: surfacing entry
type/path/ID to consumers).
