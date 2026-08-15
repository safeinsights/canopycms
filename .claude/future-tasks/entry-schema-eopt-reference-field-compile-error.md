# `entry-schema.ts` fails to compile under `exactOptionalPropertyTypes` (reference fields)

## Priority: P1 [BOTH] — raised from P2: confirmed to break compilation against the built package, not just the source

Found 2026-08-14 while verifying an independent code review's SUSPECTED
finding on `meta.entryType`/`meta.entryId` (unrelated — see
`docs/adopter-migration.md`'s entry on that). Not a regression: reproduced on
`entry-schema.ts` unmodified by that work.

**Update 2026-08-14 (second review pass):** the original write-up below reproduced the
error by compiling `entry-schema.ts` directly from source, and concluded the error is
"not gated on `skipLibCheck`." That conclusion does not hold for the way a real adopter
actually consumes the package. Building the package (`pnpm --filter canopycms build`)
and compiling a small adopter program against the **built `dist/entry-schema.d.ts`**
with `exactOptionalPropertyTypes: true` reproduces `TS2344` with its error location
inside `dist/entry-schema.d.ts` itself — a library declaration file, not the adopter's
own source. Confirmed directly: the identical adopter program compiles clean with
`skipLibCheck: true` and only that flag changed. So against the built package (the only
way it ships), this error **is** gated by `skipLibCheck`, and `skipLibCheck: true` (the
Next.js default) avoids it entirely. The severity is still real: an adopter who sets
`exactOptionalPropertyTypes: true` together with `skipLibCheck: false` cannot compile
against this package **at all** today, before writing a line of their own code — worse
than the original write-up's framing of "hits this at the adopter's own compile time"
for a specific generic instantiation.

## Problem

`entry-schema.ts`'s `FieldValue<F>` conditional type has a branch for
reference fields with a resolved target schema:

```ts
: F extends { type: 'reference'; resolvedSchema: infer S }
  ? ScalarValue<F, InferContentShape<Extract<S, readonly InferableField[]>> | null>
```

`InferableField.resolvedSchema` is itself optional
(`resolvedSchema?: readonly InferableField[]`). Under
`exactOptionalPropertyTypes: true`, re-merging the narrowed `resolvedSchema: S`
back into `F` (via `F & { resolvedSchema: ... }`, used a few lines up in the
same conditional chain for the `type: 'reference'` narrowing) makes `S`
potentially include the literal `undefined` from the optional property, and
`S & undefined` cannot satisfy `Extract<S, readonly InferableField[]>`'s
`readonly InferableField[]` constraint. Verified directly:

```
$ pnpm exec tsc --project <tsconfig with exactOptionalPropertyTypes: true>
src/entry-schema.ts(104,23): error TS2344: Type '{ type: "reference"; resolvedSchema: S; } & F' does not satisfy the constraint 'InferableField'.
  Types of property 'resolvedSchema' are incompatible.
    Type 'S & (readonly InferableField[] | undefined)' is not assignable to type 'readonly InferableField[]'.
      Type 'S & undefined' is not assignable to type 'readonly InferableField[]'.
```

This is the only `entry-schema.ts` error under that flag (isolated by
grepping the full run's output for the file). Confirmed pre-existing on
`main`/every commit checked, not introduced by any recent change.

## Blast radius

- **The package's own build/typecheck is unaffected** — `exactOptionalPropertyTypes`
  is not set in `tsconfig.base.json`, so `pnpm typecheck` is green today.
- **Against the built package (`dist/`), this IS gated by `skipLibCheck`.** Verified
  directly: `pnpm --filter canopycms build`, then compiling a small adopter program
  against `dist/index.d.ts` with `exactOptionalPropertyTypes: true` reproduces `TS2344`
  with the error location inside `dist/entry-schema.d.ts` (a shipped declaration file),
  and the identical program compiles clean with `skipLibCheck: true` and no other
  change. This corrects the original write-up above, which reproduced the error by
  compiling `entry-schema.ts` from source and concluded it was not gated by
  `skipLibCheck` — that conclusion was accurate for the source but does not describe
  how an adopter actually consumes the package. `skipLibCheck: true` (the Next.js
  default) avoids the error entirely, with no other workaround needed.
- **Any adopter combining `exactOptionalPropertyTypes: true` with `skipLibCheck: false`
  cannot compile against this package at all** — not gated on using a `reference`
  field with `resolvedSchema` and `TypeFromEntrySchema` themselves, since the error is
  in the shipped `.d.ts` and surfaces for anyone who imports from `canopycms` with
  `skipLibCheck: false` under that flag, before writing a line of their own code.
- Neither adopter currently sets `exactOptionalPropertyTypes`, so this is
  latent, not live. But the README now has a section instructing eOPT
  adopters how optional fields behave (added alongside the
  optional-property-inference work), and it now states the `skipLibCheck: true`
  requirement explicitly (see `README.md` and `docs/adopter-migration.md`,
  "`required: false` now infers an optional property").

## Fix direction (not investigated in depth)

Avoid re-widening `resolvedSchema` through the optional-property merge —
e.g. narrow `S` to `Extract<S, readonly InferableField[]>` before it re-enters
the `F & {...}` intersection, or restructure the `type: 'reference'` branch to
extract `resolvedSchema` via its own `infer` clause guarded by
`extends readonly InferableField[]` (matching the pattern the `block`
branch already uses for `templates`) rather than intersecting the narrowed
field back into `F`.

## Verification

Reproduce with a tsconfig extending `packages/canopycms/tsconfig.json` and
adding `"exactOptionalPropertyTypes": true`, then
`tsc --project <that config>` and grep the output for `entry-schema.ts`.
