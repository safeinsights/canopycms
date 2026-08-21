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
sandbox the runtime probe already builds, writes a consumer importing every testable entry
point, and typechecks it with `module`/`moduleResolution: nodenext` and `skipLibCheck`
deliberately **off** — that setting is precisely what hides the defect, so the guard must not
inherit it. It fails on any `TS2834`/`TS2835`/`TS2307` diagnostic whose path points into one
of our own `dist/` directories; third-party diagnostics are ignored, because the sandbox has
no `@types/node` and dependencies emit their own unrelated noise. Cost is about 2s.

The two passes are genuinely independent and both are required: **a `.d.ts` regression leaves
the runtime probe completely green.** That was verified rather than assumed — stripping
`.js` off one specifier in a built `dist/server.d.ts` left all 17 runtime imports passing and
turned only the type pass red. DEVELOPING.md documents that as the way to re-verify the guard
after changing either half.

ARCHITECTURE.md's "ESM Output Must Be Node-Resolvable" section and DEVELOPING.md's
"Published-Package ESM Import Check" section were both updated.
