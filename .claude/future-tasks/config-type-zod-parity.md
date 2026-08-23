# The config shape is defined three times, hand-synced, with a silent failure mode

## Priority: P2

Found 2026-08-23 by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md).

## Problem

Three definitions of the same shape, with **no structural link between them** — no
`z.infer`, no `satisfies`, and no type-parity test:

1. `config/types.ts` — 559 lines, **19 hand-written `export interface`, zero
   `z.infer`**. Its own header says *"These are pure TypeScript types - Zod schemas
   are in ./schemas/"*.
2. `config/schemas/{field,collection,config,media,permissions}.ts` — 431 lines of
   zod for the same shapes.
3. Within `config/types.ts` itself: `CanopyConfig` (`:380-432`) and
   `CanopyConfigInput` (`:438-483`) are the same ~30 fields, differing only in
   branded-alias-vs-`string` and which are optional — exactly the split zod
   expresses natively as `z.input<>` / `z.output<>`. Several doc comments are
   duplicated **verbatim** between the two (e.g. the `allowNetworkRemoteInProd`
   block appears identically at `:396` and `:459`).

So adding one config option means editing three places in lockstep, and the failure
mode of missing one is **silent**. The codebase already documents that this has
bitten — `config/schemas/field.ts:74-78`:

> *"Must be listed here, not just on `ReferenceFieldConfig`: zod strips unknown keys
> by default, so a consumer that adopts this schema's parse output would silently
> delete a runtime-consumed flag and the feature would no-op with no error."*

## Fix — the cheap half first

**Do not start with a rewrite.** Add a compile-time parity assertion (~30 lines,
`expectTypeOf` is already available and used in `entry-schema.test.ts`):

```ts
expectTypeOf<z.output<typeof CanopyConfigSchema>>().toEqualTypeOf<CanopyConfig>()
expectTypeOf<z.input<typeof CanopyConfigSchema>>().toEqualTypeOf<CanopyConfigInput>()
```

That makes drift fail loudly at build time while changing no runtime behavior, and
it will immediately reveal how far apart the three already are. Converting
`types.ts` to `z.infer` aliases is a larger follow-on that this assertion should
gate, not precede.

## Related

- [duplicated-helpers-consolidation.md](duplicated-helpers-consolidation.md)
