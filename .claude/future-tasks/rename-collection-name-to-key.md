## Consider renaming `collection.name` to `key` (or similar)

### Problem

`collection.name` in `CollectionConfig` / `FlatSchemaItem` is a machine-readable identifier (e.g., `"posts"`, `"edplus-learning-at-scale"`), but the field name `name` doesn't communicate that. Compare:

- `slug` — obviously part of a URL
- `label` — obviously for human display
- `name` — ambiguous: could be display name or identifier

This ambiguity contributed to the flatten-schema bug where `name` was used as a path segment, mixing up its identity role with a display role.

### Current usage

- **Display fallback**: shown in UI when `label` is absent — permission tree (`label || name`), breadcrumbs (`label ?? name`), collection editor modal title
- **Identity**: stored in FlatSchemaItem, ContentTreeNode, EditorCollection for metadata/roundtrip purposes
- `name` is authored in `.collection.json`; `path` is computed at runtime by the meta-loader from the directory structure (not stored in `.collection.json`)
- As of the flatten-schema fix, `name` is no longer used for path construction — `flattenSchema` now uses `collection.path` exclusively. So this rename is purely about naming clarity, not correctness.

### Suggestion

Rename to `key` (or another obviously-machine-readable term). `key` signals "lookup identifier" without implying display. The `label` field already handles human-readable display.

This would affect: `CollectionConfig.name`, `FlatSchemaItem.name`, `EntryTypeConfig.name`, `.collection.json` schema, `CollectionEditor` form fields, and all references.

### Scope

Medium refactor — touches types, meta-loader, flatten, editor components, and `.collection.json` files. Not urgent since the flatten bug is fixed separately.
