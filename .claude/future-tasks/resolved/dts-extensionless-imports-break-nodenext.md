# Published `.d.ts` files use extensionless relative imports

**RESOLVED 2026-08-20** (branch `fix/canopycms-test-utils-export`, off
`epic/adopter-request-intake`). `scripts/add-js-extensions.mjs` now rewrites `.d.ts`
alongside `.js`, and `scripts/check-esm-imports.mjs` gained a second pass that typechecks
the published declarations under `nodenext`. See [Resolution](#resolution).

Found 2026-08-20 while resolving
[canopycms-test-utils-export-unbuilt.md](canopycms-test-utils-export-unbuilt.md).
Adjacent to — but not covered by — the ESM fix that added
`scripts/add-js-extensions.mjs`.

## What was wrong

`scripts/add-js-extensions.mjs` rewrites extensionless relative imports to carry `.js`, which
is what makes `dist/*.js` loadable under Node's native ESM resolver. But it only processed
`.js` files:

```js
if (!entry.isFile() || !entry.name.endsWith('.js')) continue
```

The emitted `.d.ts` files were left alone, so they still carried extensionless relative
specifiers. From a build before the fix, `packages/canopycms/dist/server.d.ts`:

```ts
export * from './content-reader'
export * from './services'
export * from './build-mode'
```

## Reproduction (the part this file originally left open)

The original write-up flagged the consumer impact as inferred, not reproduced. It has now
been reproduced against a real `pnpm pack` tarball, and the result was **worse than the
"adopter's build goes red" this file predicted**.

A consumer was typechecked against the published shape at three settings. The probe imports
a real exported type and assigns a deliberately bogus property to it, so the result
distinguishes "type resolved" from "type silently became `any`":

| moduleResolution | skipLibCheck | bogus property caught? | diagnostics |
| ---------------- | ------------ | ---------------------- | ----------- |
| `bundler`        | true         | **yes** — type is real | 0           |
| `nodenext`       | true         | **no** — type is `any` | 0           |
| `nodenext`       | false        | **no** — type is `any` | 43          |

So the failure is **silent, not loud**. TypeScript cannot resolve the re-export, and its
recovery is to type the whole import as `any` — the adopter's build stays green while every
type the package exports quietly degrades. With `skipLibCheck: true`, which most scaffolds
set (Next.js included), there is no diagnostic at all; with it off, 43 diagnostics appear but
all of them point into `node_modules`, and **none** are attributed to the adopter's own code.

The predicted "build goes red" outcome never happens. Nobody reported this because there is
nothing to report.

## Resolution

`scripts/add-js-extensions.mjs` now processes `.d.ts` as well as `.js`. Appending `.js` is
correct in a declaration file — TypeScript maps a `./x.js` specifier to `./x.d.ts`, so
declarations must name the runtime extension and never `.d.ts`.

Turning the `.d.ts` rewrite on surfaced a second, separate gap the `.js`-only pass had never
been able to see: the specifier pattern required a slash (`\.\.?\/[^'"]+`), so a bare `.` was
invisible to it. `packages/canopycms/src/operating-mode/types.ts` has exactly one
(`import type { OperatingMode as OM } from '.'`), which emitted as `from '.'` and is rejected
by both Node's ESM resolver and TypeScript's node16/nodenext modes. The pattern now matches
bare `.` and `..` and expands them through the existing directory branch to `./index.js`. It
was unit-checked against `.`, `..`, `./x`, `../x/y`, `./`, `.foo`, `pkg`, and `./x.js` to
confirm it neither misses a relative specifier nor captures a bare package name.

After the fix, all five packages' `dist/` trees contain zero extensionless relative
specifiers across `.js` and `.d.ts`, and the `nodenext` probe catches the bogus property —
i.e. the types resolve for real.

### Regression guard

`scripts/check-esm-imports.mjs` gained a `checkDeclarationResolution()` pass. It reuses the
sandbox the runtime probe already builds, writes a consumer importing every published entry
point, and typechecks it with `module`/`moduleResolution: nodenext` and `skipLibCheck`
deliberately **off** — that setting is precisely what hides the defect, so the guard must not
inherit it. Cost is about 2s.

An adversarial review of the first version of this guard found three holes in it, all since
closed; they are recorded here because each was a way the guard could report green while the
defect it exists to catch was present:

- **It filtered out diagnostics attributed to the consumer.** Only paths containing
  `node_modules/<pkg>/dist/` counted, so `TS7016` ("could not find a declaration file") and a
  consumer-located `TS2307` were both discarded. Deleting `dist/server.d.ts` outright left the
  check green — verified. The consumer file imports nothing but our own packages, so every
  diagnostic in it is ours by construction, and all of them now count.
- **It never checked that tsc ran.** No inspection of `result.error`, a killing signal, or a
  non-zero exit with empty output, so a broken TypeScript install or an OOM-killed process
  would have silently turned the pass into a permanent no-op.
- **It only type-probed the runtime-testable entries.** Every `skip` in the `PACKAGES` list is
  a *runtime* limitation and none apply to `import type`, so restricting the type pass to
  `test` entries left canopycms's whole `editor/` subtree — reachable only through `./client`
  — unguarded. It now covers every published subpath: 22 entry points rather than 17.

Third-party diagnostics are still ignored: the probe sets `types: []`, so ambient `@types` are
not auto-included and dependency declarations emit unrelated noise. The original comment
claimed the sandbox "has no `@types/node`" — that was simply wrong (`layerInNodeModules`
symlinks it in), and `types: []` is what excludes the globals. Corrected everywhere it was
repeated.

The two passes are genuinely independent and both are required: **a `.d.ts` regression leaves
the runtime probe completely green.** Verified rather than assumed, across three injected
regressions — an extensionless specifier in `dist/server.d.ts`, the same inside
`dist/editor/CanopyEditorPage.d.ts` (reachable only via `./client`), and a deleted
`dist/server.d.ts`. All three left every runtime import passing and turned only the type pass
red. DEVELOPING.md documents that as the way to re-verify the guard after changing either
half.

The rewrite pattern also gained a `--self-test` (`node scripts/add-js-extensions.mjs
--self-test`, run as the first step of `pnpm check:esm`) asserting its classification table
and an end-to-end rewrite including idempotence. The commit that introduced the widened
pattern claimed it "was unit-checked" against a list of cases; that check was ad hoc and not
reproducible from the repo, which is exactly the gap this closes. It was itself verified by
mutating the pattern in both directions — back to the old slash-requiring form, and to an
over-wide form that swallows bare package names — and confirming each mutation actually landed
before trusting that the self-test caught it.

ARCHITECTURE.md's "ESM Output Must Be Node-Resolvable" section and DEVELOPING.md's
"Published-Package ESM Import Check" section were both updated.
