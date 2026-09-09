# [P1] The CDK test suite leaks a cloud assembly per synth and filled the disk

Found 2026-09-09 by running out of disk on the dev machine: **26,537 orphaned
`cdk.out*` directories, 13 GB**, accumulated over 8 days. It stopped a task
from starting and broke app logging. Cleared manually; **it will come back**,
because nothing about the mechanism has changed.

## Mechanism

CDK's `App` synthesizes to `outdir` if given one, and otherwise to a
`mkdtemp('cdk.out')` under `os.tmpdir()` — which it never removes. Our CDK
suites construct an `App` per test helper call and set no `outdir`:

- `src/constructs/cms-deploy.test.ts` — the big one, ~222 tests, most of which
  synth
- `src/constructs/asset-support.test.ts`
- (`src/scaffold-synth.test.ts` is NOT the culprit: it sets `CDK_OUTDIR` for
  the CLI subprocesses it drives, and cleans its own scaffold directory)

Each assembly is ~3.3 MB (`TestStack.template.json`, `tree.json`,
`manifest.json`, `metadata.json`, plus staged assets). So one full CDK suite
run leaves a few hundred megabytes behind, and the machine accumulated 13 GB
across roughly eight days of ordinary work.

Confirmed rather than inferred: the orphans contain `TestStack.*` — our test
stack name, not a real deploy — with `manifest.json` at CDK version 54.0.0,
and none had an open file handle.

## Why P1 despite being test-only

It is not a slow leak. A day of active CDK work on this package is enough to
notice, and the failure mode is machine-wide rather than scoped to this repo:
a full temp filesystem breaks unrelated tooling (it stopped a background task
from starting, and app logs silently stopped being written). It cost real
debugging time to attribute, because "out of disk" surfaces as an unrelated
symptom somewhere else.

## Fix direction

Give the tests an `outdir` under a directory the suite owns and removes.

1. **Cheapest and most contained:** a vitest `globalSetup` for
   `packages/canopycms-cdk` that creates one temp root, exposes it, and
   `rm -rf`s it in teardown; test helpers pass
   `new App({ outdir: path.join(root, randomId) })`. Note several tests build
   more than one `App`/`Stack` and a few compare two synths, so the outdir has
   to be unique per App, not per file.
2. Or a shared `newTestApp()` helper in the CDK suite that does the same and is
   the only place `new App()` is called. More invasive, but then the rule is
   enforced by there being one call site — and a lint rule or a grep test could
   keep it that way.

Whichever route: **assert it.** A test that synths and then asserts
`os.tmpdir()` gained no `cdk.out*` entry would have caught this on day one, and
is the only thing that stops it regressing. Mutation-check it by removing the
`outdir` again.

## Cleanup command, for when it recurs before the fix lands

```
find "$TMPDIR" -maxdepth 1 -name 'cdk.out*' -type d -mmin +60 -print0 | xargs -0 -n 200 rm -rf
```

The `-mmin +60` matters: it avoids a synth that is currently running.
