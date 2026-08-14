# MarkdownField MDXEditor-mount unit test is flaky under full-suite load

**RESOLVED 2026-08-14 (PR #233).** Kept as the record, because the diagnosis took
three attempts and the two rejected ones are worth not re-walking.

**Cause.** Both open guesses in "Likely cause" below were right, and were the same
thing: the assertion waits on `React.lazy`'s **real dynamic import** of
`@mdxeditor/editor`, under `waitFor`'s ~1000ms default. So it was measuring how
long vitest takes to transform that module — a function of machine load and of how
many other files the `editor` project is running — rather than whether the editor
mounts. That is exactly why it reproduced only in full runs and never in isolation,
and why the shortcut below (run the editor project alone) worked as a triage tool.

**Fix.** Preload, don't wait longer. `MarkdownField.test.tsx` and
`FormRenderer.test.tsx` now statically `import '@mdxeditor/editor'` — the same
specifier `MarkdownField.tsx` lazy-loads — which puts the module in vitest's
registry during each file's import phase, so the lazy promise resolves from cache
on the first microtask. Vitest accounts that cost as import time, which no test
timeout applies to.

**Rejected first, recorded so it is not retried:** raising the `waitFor` timeout to
15s. It made the suite green, but it only widens the window the measurement has to
fit inside; the test still measures the host, and the next slower machine or bigger
project moves the goalposts again.

**Also worth knowing:** `FormRenderer.test.tsx`'s `'rich-text'` mount test had the
identical defect from the identical cause, and was failing alongside this one. Two
symptoms, one bug — this file's framing as a MarkdownField-specific flake was part
of what kept the cause hidden.

**Priority:** P3 (as filed)

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
heavier suite load. ~~A `findBy*`/`waitFor` around the mount assertion (instead
of a synchronous query) is the probable fix.~~

**DEAD END — corrected 2026-08-13.** That fix is already in place and always has
been. `MarkdownField.test.tsx:72` wraps the mount assertion in
`await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toBeTruthy())`,
and `git log` on that file shows a single commit — `ae95da25`, the very commit
this task cites as the flake's origin. So the `waitFor` was there from day one
and the flake still recurred.

Re-diagnose before spending effort. Better hypotheses: `waitFor`'s default
~1000ms timeout losing under CPU contention (raise it, or use `findBy*` with an
explicit timeout), or something in the lazy-import/Suspense chain upstream of the
mount. Verification runs on 2026-08-13: isolation 2/2 green; two full-package
runs both green for this test (199/199 files) — which given the ~1-in-2 historical
rate neither confirms nor refutes. A different flake did surface in one of those
runs (`ECOMPROMISED` from proper-lockfile in `api-editing-workflow.test.ts`),
which belongs to [proper-lockfile-hazards.md](../proper-lockfile-hazards.md).

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

- [git-manager-test-tmpdir-cleanup-race.md](../git-manager-test-tmpdir-cleanup-race.md)
  — the other known intermittent, same package, likely the cheaper of the two to fix
