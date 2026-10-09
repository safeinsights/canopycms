---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09, from the review rounds on [unknown-schema-degrades](resolved/unknown-schema-degrades.md). Five LOWs accepted there: an adopter read of a healthy entry embeds a referenced unavailable target's raw data and a URL that 404s; schema-snapshot churn while two images share EFS, and function fingerprints that change with the minifier; the per-process issue log never re-logs; a restored draft stays unverified after its type becomes available; no HTTP test drives a real degraded resolve.
---

# Unavailable entry types: accepted follow-ups

Each was judged LOW (cost, logging or consistency; never a write against a missing schema) and
left out of the change that introduced unavailable entry types.

1. **Adopter reads of a reference into an unavailable entry.** `ContentStore.read()` of a healthy
   entry resolves a reference whose target's type is unavailable with that target's raw data and
   its `urlPath`, while `readByUrlPath` of that URL is a not-found and listings leave the target
   out (`content-store.ts`, `resolveSingleReferenceOnce` with `allowUnavailableEntryType`).
   Decide whether adopter reads should get a `MissingReference` instead. The editor's picker and
   preview need the raw read, so the choice has to be per caller.
2. **Snapshot churn during a rolling deploy.** Two images with different registries sharing a
   workspace each rewrite `schema-cache.json` on every miss, so both re-resolve on every request
   until the old image drains. A registry holding custom-field functions fingerprints their source
   text, which a minifier may change between builds of identical schemas, so each deploy
   re-resolves every branch once (`schema/registry-fingerprint.ts`).
3. **The issue log never re-logs.** `reportSchemaIssues` in `branch-schema-cache.ts` keeps every
   line it has logged for the life of the process, so an issue fixed and then reintroduced is not
   logged again until a restart.
4. **Draft verification after the type returns.** `useDraftManager` settles a restored draft of
   an unavailable entry as unread and never re-queues it, so after a refetch makes the type
   available the draft counts as modified until its entry is opened. The editor's own refusal set
   is cleared on refetch; this one is not.
5. **No HTTP test of the real degrade path.** `__integration__/errors/unavailable-entry-type.test.ts`
   injects an already-degraded schema through `createTestServices`, so no test drives a
   `.collection.json` naming an unknown schema through `BranchSchemaCache` and the handler to the
   503. The e2e `unavailable-entry-type.spec.ts` covers that chain in a browser.
