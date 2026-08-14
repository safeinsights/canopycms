# `image-size` DoS advisory — standing risk acceptance

## Priority: P3 — this is a watch item, not a task

Split out of [baseline-2026-08-production-and-followups.md](resolved/baseline-2026-08-production-and-followups.md)
(finding A2's `image-size` row) on 2026-08-13, so its revisit triggers stay
findable after that record moved to `resolved/`. **Nothing here is asking to be
implemented.** The other three A2 advisories — `aws-cdk-lib`'s peer range,
`file-type`, and the `next` peer floors — were cleared by PR #228.

## State

`image-size` (`canopycms` production dependency, `^2.0.2`) carries a
high-severity denial-of-service-on-malformed-image advisory with **no upstream
fix**. Re-checked against the npm registry 2026-08-13: latest is still `2.0.2`,
published 2025-04-02. It is still called directly on uploaded bytes at
`assets/pipeline.ts:143`.

## Decision (JP, 2026-08-13): no code change

The real exposure is much narrower than the advisory reads:

- `computeDimensions` wraps `imageSize()` in try/catch and returns `{}`.
  Dimensions are optional, so a malformed image degrades to "no dimensions", not
  a failed upload.
- Input is byte-capped before it gets there — `RASTER_MAX_BYTES` 50MB,
  `PDF_MAX_BYTES` 25MB.
- Every API route authenticates before routing, so a crafted image burns CPU in
  the Lambda serving that authenticated user's own request.

**Consolidating onto `sharp.metadata()` was considered and rejected.** `sharp` is
dynamically imported and deliberately fails open — a missing native binary logs
and skips validation — so routing dimensions through it would make dimensions
silently vanish on any host where sharp fails to load. That trades a narrow
authenticated DoS for exactly the silent-data-loss shape the August review was
mostly about. `image-size` also handles SVG dimensions, where `sharp` needs
librsvg.

## Revisit if

1. Uploads become reachable by anyone less trusted than an authenticated editor.
2. **`image-size` ships a patch** — then it is a routine bump, not a decision.
   *(Check this trigger whenever dependencies are next audited.)*
3. `width`/`height` become required downstream rather than optional.
4. `sharp`'s decode path stops failing open.
