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

## Triage shortcut (use this before investigating)

```bash
pnpm --filter canopycms exec vitest run --project editor
```

This is reliably green for the flake, so **a MarkdownField failure in a full run is
this known flake unless the editor-only project also fails.** That turns a recurring
"is this my change?" into one command. Confirmed 2026-08-12 across several sessions.

Also ruled out: adding a `scrollIntoView` shim does **not** affect it — do not
re-walk that path.

## Frequency data

- 2026-07-24: 1 failure in 2 full runs (e2e-stabilization branch).
- 2026-08-12: 1 failure in 2 full runs **from the same commit**, and it failed
  identically on the clean base as on the branch under test. Multiple parallel
  sessions saw it independently the same evening.

## Priority note (2026-08-12)

Left at P3, but the reasoning is now conditional rather than absolute. PR #191 made
the root `pnpm test` recursive across all packages, and pnpm orders by dependency
topology, so `canopycms` runs first — a flake here delays every other package's
suite. The root `test` script carries `--no-bail`, so the other packages still run
and report independently; **if that ever changes, promote this to P2**, because it
would then gate ~200 tests (including the CDK deploy-template assertions) behind an
intermittent.

It cannot produce a false green either way — a flaked run is red. The cost is churn
and triage misattribution, which the shortcut above is meant to absorb.

## Related

- [git-manager-test-tmpdir-cleanup-race.md](git-manager-test-tmpdir-cleanup-race.md)
  — the other known intermittent, same package, likely the cheaper of the two to fix
