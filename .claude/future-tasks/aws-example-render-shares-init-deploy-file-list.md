---
priority: P3
adopters: NEITHER
summary: >-
  `renderAwsDeployExample` (cli/aws-deploy-example.ts) repeats `initDeployAws`'s list of CDK and
  workflow files and the arguments it renders them with, so a step added only to init.ts would not
  reach `examples/aws-deployment/` and the drift test could not see it. Share one render table
---
# The AWS example's renderer repeats `initDeployAws`'s file list

## Problem

`packages/canopycms/src/cli/aws-deploy-example.ts` renders the example's five files by calling
the same `templates.ts` functions `initDeployAws` (`cli/init.ts`) calls, but the list of files,
their target paths and the arguments passed are written out twice. The output is byte-identical
today: the PR #479 review ran the real `initDeployAws` in a scratch npm project with no remote and
`cmp`'d all five files. A future change that adds a render option, or post-processes one file,
only in `init.ts` would leave the example rendering the old shape, and
`aws-deploy-example.test.ts` compares the example with the renderer, not with the CLI.

## Shape of the fix

Extract one function or table, used by both `initDeployAws` and `renderAwsDeployExample`, that
maps detected values (package-manager commands, default branch, repo) to `{ path, content }` for
the five files. The example then remaps only `.github/workflows/deploy-cms.yml` to
`deploy-cms.yml`. `initDeployAws` keeps its per-file write handling (the existing-`cdk.json`
check and warnings) around the shared rendering.
