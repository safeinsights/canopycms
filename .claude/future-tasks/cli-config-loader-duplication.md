# Three CLI commands each load `canopycms.config.ts` their own way

**Status:** Open. **Priority: P3.** Filed 2026-10-06 from Phase 2 of
[image-materialization-epic.md](image-materialization-epic.md).

## State

`cli/generate-ai-content.ts`, `cli/init.ts`'s `detectMode` and `cli/asset-refs.ts`'s
`loadConfiguredAssetStore` each `jiti.import` the config, unwrap `default`/`config`/`server` the
same way, and then validate a different subset: generate-ai-content checks only that `mode` and
`contentRoot` keys exist, `detectMode` checks `mode`, and asset-refs validates `mode` and `media`
with zod. A fourth command would copy the unwrap a fourth time.

## Proposal

One `cli/load-config.ts` that imports, unwraps and validates the server config with
`CanopyConfigSchema` once, returning a typed `CanopyConfig`, and the three call sites on it. Keep
`detectMode`'s rule that a config which fails to load is an error, not a fallback to dev mode.
