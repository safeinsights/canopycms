# `build/` — Static build output

Writing AI content files to disk, and pruning what previous runs produced.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
114 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

Static build utilities (write AI content files to disk). `generateAIContentFiles` also PRUNES: it records what each run produced in `.canopy-generated.json` (`GENERATED_RECORD_FILENAME`, deliberately not the published `manifest.json`, whose `AIManifest` shape adopters read) and deletes only files a previous run recorded, so a renamed entry stops leaving a stale file advertising a dead URL. It never sweeps the output directory — that directory belongs to the adopter. The record is written as the union of old+new BEFORE any file is written, so a run that dies part-way still leaves a superset the next run can clean; recorded paths are re-checked against the output root before deletion, since the record is an on-disk file anything could edit

`resolveBuildStamp` is the single place the environment is consulted for manifest determinism —
`CANOPY_BUILD_ID` and `SOURCE_DATE_EPOCH` — and it lives here, at the build boundary, rather than
in `ai/generate.ts`, precisely so a `SOURCE_DATE_EPOCH` exported in a server environment cannot
freeze the runtime `/ai/*` route's timestamps. A malformed `SOURCE_DATE_EPOCH` warns and is
ignored rather than failing the build (same stance as `readGeneratedRecord`); note that ignoring
it while a build id is set means `generated` stays omitted, which is deliberate — a bad value
must not resurrect a field the adopter's configuration says is meaningless.
