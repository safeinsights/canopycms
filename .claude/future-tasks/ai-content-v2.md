# AI Content — Future Enhancements

v1 shipped: route handler, static build, CLI, schema-driven markdown, bundles, exclusions, field transforms. See `packages/canopycms/src/ai/`.

Also shipped since: `entryTransforms` + traversal-guarded `readSibling` + `contentId` (fold a colocated sibling artifact like `<contentId>.profile.json` into the generated markdown), and compact GFM-table rendering for flat object-list fields. See `packages/canopycms/src/ai/`.

## Planned

- **`llms.txt` / `llms-full.txt`** — emerging standard for LLM-friendly site metadata; generate alongside manifest.json
- **ETag support** — content-hash ETag on the route handler for conditional
  requests. (Corrected 2026-08-13: this bullet used to say "ETag and
  Cache-Control". `Cache-Control: public, max-age=60` has shipped in prod mode
  since the feature's first commit `de931406` — see `ai/handler.ts:92,103` — so
  only the ETag half is open.)
- **Selective rebuild** — only regenerate changed entries in the build utility (currently regenerates everything)
- **MCP server** — direct Claude Code tool integration for richer AI interactions beyond static markdown fetch
- **Per-page markdown twins** — co-located `ai.tsx` templates as a complementary per-page approach (different use case from collection-level bundles)
- **First-class sibling-artifact content concept** — deferred from the `entryTransforms` work. Rather than each consumer reading a colocated sibling ad hoc, Canopy could declare sibling artifacts in the schema and discover/load them uniformly across render + AI export. Premature today (one adopter, one sibling type; unresolved editor/validation/branch-workflow semantics) — revisit with >1 adopter or sibling type.
- **List-form rendering for description-heavy object lists** — flat object-lists render as tables today; a record with a long free-text field can read better as a `- **title** — text` list. Deferred as an explicit per-field hint (not a content-length heuristic, which would render the same field inconsistently across entries).
