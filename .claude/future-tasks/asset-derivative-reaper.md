---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-07, follow-up of the image-materialization epic. Materialized `assets/t/` derivatives are kept forever, so widths changes, re-crops and preview builds only add objects. Proposal: reap keys no in-window build's `canopy-asset-refs.json` names, after a grace period; access logs can't tell use
---
# Reap `assets/t/` derivatives no build in the rollback window references

**Status:** Open. **Priority: P3.** Filed 2026-10-07 as a follow-up of
[image-materialization-epic.md](resolved/image-materialization-epic.md).

## State

In `AssetSupport`'s default mode, everything `materialize-assets` writes under `assets/t/` is kept
forever. Keys are content-addressed, so storage grows only with distinct derivatives ever
referenced: a widths change in site code, a re-crop, or a preview build of an unmerged branch each
add objects that no later build may reference again. Nothing removes them.

## Proposal

A reaper keyed on the `canopy-asset-refs.json` files of every build still inside the rollback
window: list `assets/t/`, delete keys none of those refs files name and that are older than a grace
period (so an in-flight release's freshly materialized keys survive). Preview builds count only
while their PR is open.

Access logs are not a usable signal: CloudFront caches a derivative for up to a year, so S3 logs
undercount its use, and S3 records no last-access time.

## Open questions

- Where the set of in-window builds is read from; that is adopter release state, so the reaper
  likely takes the refs files as input rather than discovering them.
- A replica bucket needs the same deletes, or a replication rule that carries them.
