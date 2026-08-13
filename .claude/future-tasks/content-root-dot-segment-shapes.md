# `contentRoot` values with a leading `./` still defeat path comparisons

## Priority: P3

Found 2026-08-13 by the final adversarial review of `epic/adv-review-remediation`,
while checking the completeness of that epic's own `contentRoot` fix (PR-2,
finishing PR #190's threading). Not a regression from that work — the pre-fix
code failed on this shape too — but it is the part of the fix that is
incomplete against what config validation actually permits.

## Problem

`relativePathSchema` (`packages/canopycms/src/config/schemas/collection.ts:18-23`)
accepts `contentRoot: './content'`: it is relative and contains no `..`, so
validation passes. `normalizeFilesystemPath` (`packages/canopycms/src/paths/normalize.ts`)
splits on separators and drops empty segments, but a `.` segment is not empty —
so `normalizeFilesystemPath('./content') === './content'`.

The consequence is at `packages/canopycms/src/worker/cms-worker.ts`'s rebase
conflict classification. Git reports `content/.collection.json`, giving
`parentPath === 'content'`, which is compared against
`normalizedContentRoot === './content'`. They differ, so the root collection's
conflict never gets `ROOT_COLLECTION_ID`, is filtered out, and **the conflict is
silently dropped** — the branch is recorded `clean` and editors are never told.
That is the exact failure shape the epic's PR-2 set out to close for the
multi-segment case; the dot-segment case survives it.

Any other comparison of a config `contentRoot` against a filesystem- or
git-derived path is likely to share this, so treat the audit as the task rather
than just the one site.

## Why the reference pattern does not have this bug

`packages/canopycms/src/schema/schema-store.ts:230-236` derives its
`contentRootName` through `path.resolve`, which collapses `.` segments. That is
the shape to copy.

## Fix sketch

Pick ONE of these, repo-wide, rather than patching call sites:

- Have `relativePathSchema` normalize on the way in (strip leading `./`), so
  every consumer sees a canonical value and no comparison has to care. Cheapest,
  and it fixes sites nobody has audited. Check nothing depends on the raw string
  round-tripping back into a written config file first.
- Or make `normalizeFilesystemPath` drop `.` segments, and re-check its other
  callers (`content-store.ts`, `paths/validation.ts`) for anything relying on
  the current behaviour.

Then add a `contentRoot: './content'` case to the regression fixtures the epic
added (`cms-worker-rebase.test.ts`'s multi-segment root-collection test is the
natural home) so the shape is pinned rather than merely reasoned about.

## Why P3

No adopter uses a non-default `contentRoot` yet, let alone a `./`-prefixed one,
and the value is written once in `canopycms.config.ts` rather than typed
repeatedly. It is a latent trap for the first adopter who writes the path the
way a shell would, not a live defect.

## Related

- [cli-sync-migrate-ignore-adopter-content-root.md](cli-sync-migrate-ignore-adopter-content-root.md) —
  the other `contentRoot` item split out of the same epic
- `packages/canopycms/src/config/helpers.ts` — documents `contentRoot` as
  accepting multiple path segments
