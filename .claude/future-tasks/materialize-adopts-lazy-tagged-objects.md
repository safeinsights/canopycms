# `materialize-assets` leaves a lazily-written derivative expiring

**Status:** Open. **Priority: P3.** Filed 2026-10-07 from review round 3 of
[image-materialization-epic.md](resolved/image-materialization-epic.md) Phase 3.

## State

In `lazyPublicTransforms` mode the transform Lambda writes derivatives tagged `canopy-transform=lazy`,
and the bucket's `assets/t/` expiry deletes only tagged objects. When a build later references a key
the Lambda already wrote, `materialize-assets` sees it exist and reports `existed`, so the object
keeps its tag and still expires. That is self-healing while the Lambda can recompute it (every
tagged key is on its width allowlist), but not when nothing runs the Lambda any more:

- an operator sets `transformReservedConcurrency: 0` to stop abuse and leaves it past the retention;
- an adopter leaves lazy mode on a bucket they own the rules for, and their tag-filtered rule stays.

The key then expires into a permanent 403 that no build reports.

## Proposal

Have the existence check report the tag count and let `materializeAssets` treat a lazy-tagged key
as missing and rewrite it untagged. A materialized derivative is then kept forever whoever wrote it
first. `HeadObject` returns `TagCount` only to a caller with `s3:GetObjectTagging` (the
`@aws-sdk/client-s3` `HeadObjectOutput` doc), which the README's `materialize-assets` grant list
lacks, and a directive group large enough to be listed rather than HEADed (`materialize.ts`'s
`listThreshold`) gets no tag information from the listing, so it needs a HEAD per key in lazy
mode. Until then, the guidance is: remove the tag-filtered rule before leaving lazy mode.
