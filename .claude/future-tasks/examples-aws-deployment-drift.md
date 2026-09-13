# [P3] `examples/aws-deployment/` lags the `init-deploy aws` scaffold it claims to mirror

Found 2026-09-12 by the round-1 review of PR #323 (the CMS image architecture fix), which
touched only `runs-on` in the example workflow and the `platform`/build-arg lines in the
example stack. Not a regression from that PR; filed so it isn't mistaken for one.

`examples/aws-deployment/README.md` says these files are what `npx canopycms init-deploy aws`
scaffolds, but they have drifted from the templates in
`packages/canopycms/src/cli/template-files/`:

- **`deploy-cms.yml` vs `deploy-cms.yml.template`**
  - The dependency check loops over `tsx aws-cdk-lib constructs canopycms-cdk`. The
    template also checks `canopycms` (peer dependency of `canopycms-cdk`) and `aws-cdk`
    (so `npx cdk` doesn't fetch an unpinned CLI).
  - The header's and the error message's install line omit `canopycms`.
  - `on.push.paths` lacks `next.config.*`, `middleware.ts` and `public/**`, which the
    template added so those edits trigger a deploy.
- **`infrastructure/lib/cms-stack.ts` vs `cms-stack.ts.template`**
  - The commented media block lacks the template's note about when to include
    `http://localhost:3000` in `editorOrigins`.

Only the media block is guarded today: `asset-support.test.ts` checks both copies for
AssetSupport members and `editorOrigins`. Nothing else keeps the pair in step.

## Options

1. Bring the example files up to date by hand, and add a test that renders the templates
   for the npm case and diffs them against the example files (allowing the placeholders the
   example resolves by hand).
2. Generate the example files from the templates in a script, and have CI fail when the
   checked-in copies differ.
3. Replace the copies with a pointer to `init-deploy aws` output and keep only the README.

Option 1 or 2 keeps the example useful to read on GitHub; option 3 removes the drift
surface entirely.

## Overlaps

The same drift was filed independently, also on 2026-09-12, on `int-202609-a`:
[example-aws-deployment-drift-from-template.md](example-aws-deployment-drift-from-template.md)
(the whole directory, and the case for generating it) and
[example-deploy-workflow-drifted.md](example-deploy-workflow-drifted.md) (the workflow file).
The three met when `int-202609-a` was merged into `int-202609-cms-image`; fix them as one.
