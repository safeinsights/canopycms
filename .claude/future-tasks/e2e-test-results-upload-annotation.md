# [P3] Every passing E2E shard carries a "No files were found … test-results/" annotation

Found 2026-09-11 while measuring the Node 20 action-runtime fix
([resolved/gha-actions-node20-runtime.md](resolved/gha-actions-node20-runtime.md)).
With the Node 20 annotation gone, this is the only annotation left on a green CI
run. There is one on each of the four E2E shards:

> No files were found with the provided path: test-results/. No artifacts will be
> uploaded.

It predates that fix: PR #316's run on the old pins carried it too.

## Why

`ci.yml`'s e2e job runs "Upload test results" under `if: always()` with
`path: test-results/`. In CI, `playwright.config.ts` uses the `blob` and `list`
reporters; the `json` reporter that writes `test-results/results.json` runs only
locally. So in CI the directory exists only when a test leaves traces or screenshots
behind (`trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`). On a passing
shard it doesn't exist, and upload-artifact's `if-no-files-found` defaults to
`warn`.

## Fix options

- `if: failure()` on that step. The results only exist, and only matter, when a test
  failed. This also stops a cancelled run from uploading. Check that isn't wanted.
- `if-no-files-found: ignore` on it. The step stays unconditional, but a failed
  shard that somehow wrote nothing would also be silent.

Either way, confirm afterwards that a green run has zero annotations. This is the
same noise class the Node 20 fix removed: an annotation on every run is one nobody
reads, and it hides the next real one.
