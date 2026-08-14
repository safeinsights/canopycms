# Programmatic content-authoring API + a deterministic ID generator

## Priority: P1 [KB]

From the 2026-08-13/14 adopter site audits, triaged as part of the
2026-08-14 go-live backlog re-baseline. No existing task file covered this.

## Problem

One adopter site's dataset-ingestion script writes entry YAML files directly
with raw `writeFileSync`, entirely outside CanopyCMS's own write path. This
means bulk-ingested content:

- **Bypasses schema validation** — nothing checks the written YAML against
  the entry type's schema the way `ContentStore.write()` does via
  `validation/entry-validator.ts`. A malformed bulk import is invisible until
  something downstream trips on it.
- **Bypasses the ID index** — `ContentStore`'s content-ID index
  (`content-index-generation.ts`) is built by the package's own write/scan
  paths. Files dropped in by hand aren't registered the way a `write()` call
  would register them, so reference resolution and ID-based lookups may
  silently miss ingested content until a full rescan happens to pick it up.
- **Copy-pastes Canopy's Base58 ID alphabet.** The script needs
  content-ID-shaped identifiers and reimplemented the same alphabet CanopyCMS
  uses internally, rather than being able to call a real generator. If the
  internal ID scheme ever changes, this copy silently drifts and produces
  IDs that look valid but weren't generated the same way.

This is a real gap: there is currently no supported way to author content
programmatically (bulk import, migration scripts, dataset ingestion) that
goes through the same validation and indexing guarantees the editor UI gets
for free.

## Proposed solution

- **A programmatic content-authoring API** — a server-side function (or
  small set of them) that performs the same write CanopyCMS's editor save
  path does (schema validation, ID assignment, index update), callable from a
  script rather than only reachable through the API/editor. This is
  distinct from `ContentStore.write()` being merely *importable* — it needs
  to be documented and supported as a scripting entrypoint, which ties
  directly into
  [script-runner-entrypoint.md](script-runner-entrypoint.md)'s "how do you
  even run a script with Canopy loaded" gap.
- **Export a deterministic content-ID generator** — whatever internal
  function/module produces Canopy's Base58 content IDs today, exported so
  a bulk-ingest script (like the one above) can generate real IDs instead of
  hand-copying the alphabet.

## Related

- [script-runner-entrypoint.md](script-runner-entrypoint.md) — the
  prerequisite "how do I run a script with Canopy loaded at all" gap this
  builds on.
- [content-validation-gate.md](content-validation-gate.md) — a bulk-ingest
  API that goes through real schema validation still wouldn't catch a
  render-exploding MDX body; the two are complementary, not overlapping.
