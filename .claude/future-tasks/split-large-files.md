# Split Large Files

Extract focused modules from oversized files to improve maintainability.

## api/schema.ts (949+ lines)

Wire-format conversion functions (`toWireEntryType`, `toWireCollection`, `toWireFlatSchema`, `resolveSchemaRef`, and the `Wire*` type definitions) are a separate concern from endpoint handlers.

**Action**: Extract to `src/api/schema-wire.ts`:

- All `Wire*` type definitions (WireEntryType, WireCollectionConfig, WireFlatSchemaItem)
- `resolveSchemaRef()`, `toWireEntryType()`, `toWireCollection()`, `toWireFlatSchema()`
- The `Registry` type alias

## content-store.ts (793 lines)

1. **Duplicated index-update logic** in the `write()` method (two nearly identical blocks for updating the content ID index)
2. **`resolveReferencesInData`** private method (lines 693-758) could be extracted to `reference-resolver.ts`

**Action**:

- Extract a shared `updateContentIdIndex()` helper within content-store.ts
- Move `resolveReferencesInData` to `src/reference-resolver.ts` (which already exists and handles reference resolution)

## Files

- `src/api/schema.ts` — extract wire types/conversions to `src/api/schema-wire.ts`
- `src/content-store.ts` — deduplicate index logic, extract reference resolution
- `src/reference-resolver.ts` — existing file, add reference-in-data resolution
