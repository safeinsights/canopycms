# MarkdownField MDXEditor-mount unit test is flaky under full-suite load

**Priority:** P3

## Symptom

`src/editor/fields/MarkdownField.test.tsx > mounts the real MDXEditor with our
custom image dialog wired in` intermittently fails in FULL `pnpm test` runs
(`AssertionError: expected null to be truthy` — the editor DOM node isn't
mounted yet when asserted) but passes when the file runs in isolation and on
most full runs. Observed 2026-07-24 on the e2e-stabilization branch right
after merging `integration-202607-a` (1 failure in 2 full runs); the test and
component were not touched by that merge — it ships with the assets/media epic
(PR 6, `ae95da2`).

## Likely cause

MDXEditor mounts asynchronously in jsdom; the assertion races the mount under
heavier suite load. A `findBy*`/`waitFor` around the mount assertion (instead
of a synchronous query) is the probable fix.

## Repro

Loop `pnpm test` (package `canopycms`) until it fails, or run the editor
project with CPU contention. Isolation always passes.
