# `entry-schema.ts` fails to compile under `exactOptionalPropertyTypes` (reference fields)

## Priority: P2 [BOTH]

Found 2026-08-14 while verifying an independent code review's SUSPECTED
finding on `meta.entryType`/`meta.entryId` (unrelated — see
`docs/adopter-migration.md`'s entry on that). Not a regression: reproduced on
`entry-schema.ts` unmodified by that work.

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
- **Reachable by adopters**: `TypeFromEntrySchema<T>` (the exported alias for
  `InferContentShape<T>`) is the public entry point that walks into
  `FieldValue`. Any adopter schema with a `type: 'reference'` field plus a
  `resolvedSchema`, run through `TypeFromEntrySchema`, in a project with
  `exactOptionalPropertyTypes: true`, hits this at the adopter's own compile
  time — not gated on `skipLibCheck`, since it is the adopter's own
  instantiation of an exported generic type, not a library-internal
  declaration-file check.
- Neither adopter currently sets `exactOptionalPropertyTypes`, so this is
  latent, not live. But the README now has a section instructing eOPT
  adopters how optional fields behave (added alongside the
  optional-property-inference work), so an eOPT adopter with a reference
  field is now a documented, expected combination that doesn't compile.

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
