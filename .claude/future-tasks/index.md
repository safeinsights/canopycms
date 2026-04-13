# Future Tasks Index

Priority levels:

- **P0** — Blocks production launch; data loss, security, or crash
- **P1** — Significant correctness issue under normal use; important quality debt
- **P2** — Useful enhancement, moderate quality improvement, or feature work
- **P3** — Nice-to-have; low-impact

---

## P0 — Must fix before multi-editor prod launch

| File                                                               | Summary                                                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [index-staleness-multiprocess.md](index-staleness-multiprocess.md) | ContentId index never invalidated after git ops (pullBase, rebase, checkout); index also diverges across processes; stale index → wrong-file saves |

---

## P1 — High-impact correctness or quality

| File                                                                         | Summary                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [preview-bridge-security.md](preview-bridge-security.md)                     | `postMessage` handlers don't validate `event.source`; any script can inject draft-update messages                             |
| [editor-async-patterns.md](editor-async-patterns.md)                         | `ReferenceField` refetches on every render; `useReferenceResolution` and `loadEntry` have no cancellation for stale responses |
| [stale-draft-prevents-content-load.md](stale-draft-prevents-content-load.md) | Stale localStorage draft permanently blocks fresh content load with no user indication                                        |
| [dual-react-problem.md](dual-react-problem.md)                               | Dual React instance crash when adopters use `file:` references in their Next.js app                                           |
| [e2e-reset-race-condition.md](e2e-reset-race-condition.md)                   | ENOENT errors during e2e test reset due to file deletion/recreation timing                                                    |
| [flaky-comment-store-tests.md](flaky-comment-store-tests.md)                 | Race conditions in concurrent comment store tests require retry workarounds                                                   |
| [swr.md](swr.md)                                                             | Multiple independent `useEffect` hooks fire duplicate API calls on initial editor load; SWR would deduplicate                 |
| [content-store-validation.md](content-store-validation.md)                   | Schema validation not enforced at the API write boundary; unvalidated data can be saved                                       |
| [editor-state-context-migration.md](editor-state-context-migration.md)       | Complete migration of `Editor.tsx` inline state to `EditorStateContext`                                                       |

---

## P2 — Enhancements and feature work

| File                                                                               | Summary                                                                                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [content-store-lock-key.md](content-store-lock-key.md)                             | Use content ID (not physical path) as lock key in ContentStore — immune to rename races; new-entry fallback to logical key |
| [validate-entry-type-names.md](validate-entry-type-names.md)                       | Reference fields can specify non-existent `entryType` names; add config-time validation                                    |
| [rename-collection-name-to-key.md](rename-collection-name-to-key.md)               | Rename `collection.name` → `collection.key` to clarify its machine-readable role                                           |
| [user-metadata-optimization.md](user-metadata-optimization.md)                     | Batch user metadata endpoint + possible API namespace reorganization                                                       |
| [user-metadata-caching.md](user-metadata-caching.md)                               | Client/server caching with TTL for user metadata to reduce redundant API calls                                             |
| [readbyurlpath-entry-type.md](readbyurlpath-entry-type.md)                         | Return `entryType` from `readByUrlPath` to enable content-type-based routing                                               |
| [readbyurlpath-collection-url-support.md](readbyurlpath-collection-url-support.md) | Add `urlPath` field to `listEntries` and root path handling in `readByUrlPath`                                             |
| [link-by-entry.md](link-by-entry.md)                                               | Stable entry-ID links that resolve to current URL paths at build time                                                      |
| [url-mapping-system.md](url-mapping-system.md)                                     | Flexible URL-to-content mapping: date-based URLs, custom slug transforms, multiple patterns per collection                 |
| [list-permission-level.md](list-permission-level.md)                               | New "list" permission level: see content exists without read/edit access                                                   |
| [dev-settings-per-branch.md](dev-settings-per-branch.md)                           | Dev-mode settings (groups, permissions) isolated per git branch                                                            |
| [partner-data-in-subcollections.md](partner-data-in-subcollections.md)             | Move partner YAML into partner sub-collection directories                                                                  |
| [split-large-files.md](split-large-files.md)                                       | Extract wire-format conversion, reference resolution, and index logic into focused modules                                 |
| [deletion-checker-refactor.md](deletion-checker-refactor.md)                       | Refactor `DeletionChecker` to use `traverseFields` — eliminates duplicated traversal logic that has caused bugs twice      |
| [adopt-changesets.md](adopt-changesets.md)                                         | Replace auto-patch publishing with changesets for deliberate semantic versioning                                           |
| [audit-logging.md](audit-logging.md)                                               | Audit trail for permission/group changes with query API and notifications                                                  |

---

## P3 — Nice-to-have

| File                                             | Summary                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [ai-content-v2.md](ai-content-v2.md)             | `llms.txt` metadata, HTTP caching headers, selective rebuild for AI content  |
| [schema-faq-glossary.md](schema-faq-glossary.md) | Dedicated FAQ and glossary schema collections for reuse across pages         |
| [FIXES.md](FIXES.md)                             | Older catch-all list; mostly superseded — review and migrate to proper files |

---

## Deferred from 2026-04 baseline review (minor)

Small findings not worth dedicated task files; fix opportunistically:

- `getErrorMessage()` pattern: 45 inline `err instanceof Error ? err.message : '...'` across 21 files — use `getErrorMessage()` from `utils/error.ts` instead (`worker/cms-worker.ts` has 9, `api/permissions.ts` has 5)
- `CanopyConfigSchema` includes `schema` field that `CanopyConfig` TS type doesn't — Zod/TS drift in `config/schemas/config.ts:42`
- `relativePathSchema` path-traversal check uses `includes('..')` (substring) not segment equality — `config/schemas/collection.ts:15`
- `MediaConfig.publicBaseUrl` accepts any string in TS but Zod enforces URL format — `config/types.ts:133`
- `composeCanopyConfig` has dead conditional spread for `gitBotAuthorName` at `config/helpers.ts:165` — remove it
- `listAssets` endpoint has no auth guard beyond the handler-level authn check — decide whether asset key enumeration is acceptable for all authenticated users
