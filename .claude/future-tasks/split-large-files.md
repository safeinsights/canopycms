# Split Large Files

Extract focused modules from oversized files to improve maintainability.

## api/schema.ts (949+ lines)

Wire-format conversion functions (`toWireEntryType`, `toWireCollection`, `toWireFlatSchema`, `resolveSchemaRef`, and the `Wire*` type definitions) are a separate concern from endpoint handlers.

**Action**: Extract to `src/api/schema-wire.ts`:

- All `Wire*` type definitions (WireEntryType, WireCollectionConfig, WireFlatSchemaItem)
- `resolveSchemaRef()`, `toWireEntryType()`, `toWireCollection()`, `toWireFlatSchema()`
- The `Registry` type alias

## content-store.ts (~~793~~ **1734 lines** as of 2026-08-13 — more than doubled)

1. ~~**Duplicated index-update logic** in the `write()` method (two nearly identical blocks for updating the content ID index)~~ — **STALE, verified 2026-08-13.** Only **one** `liveIndex.add(...)`/`updatePath(...)` block remains in `write()` (~`:1091-1099`); the duplication was consolidated by other content-store work since this was filed. Note also that `resolveReferencesInData` is still a private instance method (~`:1594-1670`), but `reference-resolver.ts` (175 lines) is **not** the move target — it serves a different concern (ID→display-value resolution for the reference-field UI, not read-time data resolution).
2. **`resolveReferencesInData`** private method (lines 693-758) could be extracted to `reference-resolver.ts`

**Action**:

- Extract a shared `updateContentIdIndex()` helper within content-store.ts
- Move `resolveReferencesInData` to `src/reference-resolver.ts` (which already exists and handles reference resolution)

## Files

- `src/api/schema.ts` — extract wire types/conversions to `src/api/schema-wire.ts`
- `src/content-store.ts` — deduplicate index logic, extract reference resolution
- `src/reference-resolver.ts` — existing file, add reference-in-data resolution
