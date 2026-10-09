---
priority: P3
summary: >-
  New 2026-10-09. `preview-first-paint.spec.ts` fails locally against the dev server at its last step ("requests rendered alongside previews keep public URLs"): a preview page's HTML lacks the raw-route `w=200` thumbnail URL. Reproduced on `chore/backlog-frontmatter` (1c0a99ec) with no other change. Find whether the spec needs the production server CI runs, or the dev server renders differently
---
# `preview-first-paint.spec.ts` fails against the local dev server

**Status:** Open. **Priority: P3.** Filed 2026-10-09 while running the preview e2e specs for
[preview-reference-resolution-depth.md](resolved/preview-reference-resolution-depth.md).

## State

`pnpm test:e2e e2e/tests/preview-first-paint.spec.ts` (local, `CANOPY_E2E_PORT` set, dev server)
fails every run, on its base commit too, at the step that fetches `/preview/home?branch=main` and
`/hero` sixteen times concurrently as admin. The preview pages' HTML does not match
`"/api/canopycms/assets/raw/assets/t/c=…,w=200/<hash32>/`. The earlier steps of the same test
pass, including the in-browser check that every preview image loads through the raw route.

CI runs the suite against `next build && next start`, and a run of this spec against a local
production build on another branch passed, so the dev server is the likely difference. Not
confirmed here: this spec against a production build on the base commit.

## Next step

Run the spec against a production build locally; if it passes, either make the spec skip that step
on a dev server or find what the dev server renders differently for concurrent preview requests.
