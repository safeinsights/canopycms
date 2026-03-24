# AI Content — Future Enhancements

v1 shipped: route handler, static build, CLI, schema-driven markdown, bundles, exclusions, field transforms. See `packages/canopycms/src/ai/`.

## Planned

- **`llms.txt` / `llms-full.txt`** — emerging standard for LLM-friendly site metadata; generate alongside manifest.json
- **HTTP caching headers** — ETag and Cache-Control based on content hash for smarter downstream caching on the route handler
- **Selective rebuild** — only regenerate changed entries in the build utility (currently regenerates everything)
- **MCP server** — direct Claude Code tool integration for richer AI interactions beyond static markdown fetch
- **Per-page markdown twins** — co-located `ai.tsx` templates as a complementary per-page approach (different use case from collection-level bundles)
