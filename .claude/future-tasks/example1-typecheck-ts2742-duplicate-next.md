# `apps/example1` typecheck TS2742 on the `canopycms-next` static helpers: latent, not reproducing

**Priority: P3 [NEITHER].** Does not reproduce today. `pnpm install --frozen-lockfile` then
`pnpm typecheck` (the CI invocation) passes for `apps/example1` with zero TS2742s, because
`apps/example1/node_modules/next` and `packages/canopycms-next/node_modules/next` resolve to the
same pnpm store path (`next@15.5.21`, identical peer-dependency hash), so `tsc` never has to name a
type by reaching across two physical copies.

## What recurs it

Nothing pins the two installs to stay aligned. A dependency bump that changes one side's `next` peer
resolution re-creates two copies, and the two exported `const` arrows in
`apps/example1/app/lib/canopy.ts` (`contentSitemap` at line 67 and `entryToMetadata` at line 77, with
inferred types mentioning Next's metadata types) fail with TS2742 ("inferred type cannot be named without a
reference to `.../packages/canopycms-next/node_modules/next/...`").

## Fix if it recurs

Do not hoist `next` to the root; each package stays self-sufficient. Prefer making `canopycms-next`
re-export the Next types it surfaces (`generateContentSitemap` / `entryToMetadata` on
`NextCanopyContextResult`, `packages/canopycms-next/src/static.ts`), so any adopter with a nested
install can name them through `canopycms-next`. That survives either install layout, and adopters
hit the same two-copy layout. The alternative, annotating the two bindings explicitly, fixes only
the example app.
