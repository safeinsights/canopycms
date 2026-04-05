## Feature: Customizable title extraction for the editor

### Problem

The editor sidebar displays entry titles using a hardcoded heuristic in `api/entries.ts`:

```typescript
const title = data.title ?? data.name
```

This is fragile for complex schemas (e.g., block-based schemas where the "title" might live in a nested block, or schemas that use a different field name entirely). The `readTitle` function was removed during the `listEntries` consolidation, replaced by `extractTitle()` in `api/entries.ts` which does the same thing inline, but the underlying problem remains.

### What readTitle did (removed, behavior preserved)

The old `readTitle` in `api/entries.ts` was a standalone function that read a file, parsed it with gray-matter (md/mdx) or JSON.parse, and extracted `data.title ?? data.name`. It was a separate file read just for the title. After consolidation, this logic lives in `extractTitle()` (same file), which receives data from the shared `listCollectionEntries` (which already reads the full file via `readEntryData`). The behavior is identical — title comes from frontmatter for md/mdx or from JSON fields — just without the redundant file read. The fallback chain is: `data.title ?? data.name ?? entryType.label`.

### How the schema flows (context for implementation)

The adopter doesn't directly create `EntryTypeConfig`. The flow is:

1. **Adopter defines field schemas** in code via `defineEntrySchema([...])` — produces an `EntrySchema` (currently just `readonly FieldConfig[]`)
2. **Adopter registers schemas** via `createEntrySchemaRegistry({ postSchema, docSchema })` — type is `Record<string, EntrySchema>` (maps names to field arrays)
3. **`.collection.json` files on disk** define entry types as `EntryTypeMeta`: `{ name, schema: "postSchema", format: "md", label? }` — persisted, editable via the UI
4. **Schema resolution** (`resolveEntryTypes` in `schema/meta-loader.ts`) combines `EntryTypeMeta` + registry lookup into `EntryTypeConfig`

### Where NOT to put titleExtractor

- **Not in `.collection.json`** — it's edited via the UI, which is wrong for a code-level concern. Also entry types are per-collection, so the same schema used in multiple collections would need the title config repeated each time.
- **Not in `EntryTypeConfig` directly** — this is assembled internally, not directly controlled by adopters.

### Proposed Direction

The title extraction logic should live where the adopter defines their entry schema — alongside `defineEntrySchema` or in the entry schema registry. Currently `EntrySchema` is just `readonly FieldConfig[]` and the registry is `Record<string, EntrySchema>`. It's fine to change `EntrySchema` to a richer type that can carry metadata like a title extractor function alongside the field definitions. We only have two internal test apps adopting, and one external adopter we control.

The key constraint: the adopter defines the schema once in code, and it's referenced by name from `.collection.json`. The title extraction logic should follow that same path — defined once with the schema, resolved automatically wherever that schema is used.

Default when no custom extraction is provided: `data.title ?? data.name ?? entryType.label` (current behavior in `extractTitle()` in `api/entries.ts`). Or even potentially falling back to a transformed version of the slug, which is guaranteed to exist.

### Use Cases

- Block-based page schemas where the page title is in a `hero.title` field
- Schemas using `heading`, `label`, or `displayName` instead of `title`
- JSON schemas with complex nested structures
- Multilingual schemas where the title field varies by locale

### Notes

- This affects the editor sidebar (`editor-utils.ts` line ~150) and the API entries handler (`extractTitle` in `api/entries.ts`). Both should use the same extraction logic.
- The title extractor lives in the adopter's code (not persisted to disk in `.collection.json`).
