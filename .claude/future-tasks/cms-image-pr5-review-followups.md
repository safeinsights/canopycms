# [P3] Follow-ups from the review of the CMS image smoke test

**Priority:** P3. Each item was rated LOW, and none breaks a build or a deploy that works today.
**Found:** 2026-09-12, by the code review of PR 5 of
[cms-image-build-epic.md](cms-image-build-epic.md) (the `standalone-image` smoke test and its
scaffold fixes): items 1-3 in round 1, item 4 in round 2. All four were left out of that PR.
Items 2 and 3 were resolved on 2026-09-13 by PR #332 (`fix/scaffold-cdk-typecheck`). Items 1 and 4
are open.

## 1. `init-deploy aws` rewrites the whole of an adopter's `tsconfig.json`

`excludeFromTsconfig` in `cli/init.ts` re-serializes a plain-JSON `tsconfig.json` with
`JSON.stringify(…, null, 2)`. A file indented with 4 spaces or tabs comes back with 2 spaces, CRLF
line endings become LF, and the diff covers the whole file for a one-entry change. Every other
file `init-deploy aws` writes goes through `writeFile`, which skips an existing file unless
`--force` is set or the user confirms. This edit happens unconditionally, non-interactive mode
included.

Decide:
- keep the adopter's indentation and line endings, or insert the entry as text;
- whether editing an existing adopter file should follow `writeFile`'s `--force`-or-confirm rule.

## 2. Nothing type-checks the scaffolded CDK app any more — RESOLVED 2026-09-13

`infrastructure/` is now excluded from the app's `tsconfig.json` and from the image build context,
so the CDK app is not type-checked anywhere:

- `cdk.json.template` runs it with `node --import tsx infrastructure/bin/app.ts`, which strips
  types without checking them;
- `deploy-cms.yml.template` has no type-check step;
- the templates include no `infrastructure/tsconfig.json`.

Before, an adopter who had installed the CDK dependencies in the app got a type error from
`next build` for a misspelled `CanopyCmsService` prop. Now that prop would be dropped silently, and
the deploy would use the default.

Direction: scaffold `infrastructure/tsconfig.json`, and add `tsc --noEmit -p infrastructure` to the
deploy workflow template, where the CDK dependencies are already installed.

**Resolved** by PR #332 (`fix/scaffold-cdk-typecheck`), in that direction.

- `init-deploy aws` writes `infrastructure/tsconfig.json` from `cdk-tsconfig.json.template`. It
  extends the project's `tsconfig.json`, because tsx resolves that file's `paths` aliases and
  compiles `canopycms.config.ts` with its options. It overrides what the CDK app needs: bundler
  resolution, `.ts` imports, `types: ["node"]`, `noEmit`, `exclude: []`, and `incremental` and
  `composite` off. It also resets `verbatimModuleSyntax`, `exactOptionalPropertyTypes` and
  `noPropertyAccessFromIndexSignature`, which tsx never applies to `infrastructure/` and which fail
  the generated stack.
- The workflow template's "Type-check the CDK app" step runs `npx tsc --noEmit -p infrastructure`
  after the dependency check and before AWS credentials. It first fails with a named error when
  `typescript` is not installed, because `npx tsc` would otherwise download npm's deprecated `tsc`
  package. The workflow also runs on a change to `tsconfig.json` alone.
- `scaffold-synth.test.ts` reads that command out of the generated workflow and runs it on a
  scaffold with a create-next-app `tsconfig.json`. It passes, lists only the CDK app and
  `canopycms.config.ts`, resolves an `@/` alias, and passes with the four reset options switched on
  in the project's `tsconfig.json`. It fails with TS2561 on a misspelled `memorySize`.
- `examples/aws-deployment/` got the same file and step.

## 3. A plugin wrapped around `withCanopy` loses Next 16's Turbopack error — RESOLVED 2026-09-13

`withCanopy` decides whether to add `turbopack: {}` from the config it is given. A plugin that wraps
`withCanopy`'s output adds its `webpack` after that decision, as `withBundleAnalyzer(withCanopy({}))`
would. The `turbopack: {}` then silences Next 16's guard for that outer `webpack` too. The build
still succeeds, and Turbopack ignores the outer `webpack` config, as it would under Next's own
suggested fix, the same key. What is lost is the error saying so. The other order,
`withCanopy(withBundleAnalyzer({}))`, keeps the guard.

Decide: document that `withCanopy` should be the outermost wrapper, or accept this.

**Resolved** by PR #332 (`fix/scaffold-cdk-typecheck`): documented. README's `withCanopy()` section says to
make it the outermost wrapper, and why.

## 4. An unreadable Next version gets no `turbopack` key, so a Next 16 build can still exit

Found by the round-2 review. `installedNextMajor` finds `next` by walking `node_modules` on disk, but
`withCanopy` resolves React with `createRequire`. Under Yarn PnP there is no `node_modules`, so the
version reads as unknown while React still resolves. `withCanopy` then adds its `webpack` function
but no `turbopack: {}`, and Next 16's default Turbopack build exits.

Leaving the key out when the version is unknown was decided during PR 5: on Next 13 and 14 an
unknown top-level `turbopack` is reported as an invalid option. Revisit it with
[yarn-support-decision.md](yarn-support-decision.md). If Yarn Berry is supported, read the Next
version through the same resolution `withCanopy` uses for React.
