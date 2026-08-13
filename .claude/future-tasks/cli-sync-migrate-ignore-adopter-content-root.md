# CLI `sync`/`migrate` never read the adopter's configured `contentRoot`

## Priority: P2

Found while finishing PR #190's `contentRoot` threading (fix/content-root-threading):
three other sites with the same "compares/derives against the wrong shape of
`contentRoot`" bug were fixed (`cms-worker.ts`'s rebase conflict classification,
`operating-mode`'s `getContentRoot()`, and `editor/editor-utils.ts`'s
`buildPreviewSrc`). This is a fourth site of the same underlying gap, but it needed a
real architectural addition to fix properly, so it was split out rather than folded in.

## Problem

`packages/canopycms/src/cli/sync.ts` (lines 149, 240, 364) and
`packages/canopycms/src/cli/migrate.ts` (line 186) all do:

```ts
const contentRoot = options.contentRoot || 'content'
```

`options.contentRoot` comes only from the `--content-root` CLI flag — none of the four
sites ever load the adopter's `canopycms.config.ts` to read the real
`config.contentRoot`. So for any adopter who configures a non-default content root
(single- or multi-segment, e.g. `"cms-content"` or `"cms/content"`), `canopycms sync
push`/`pull`/`both` and `canopycms migrate` silently default to `'content'` unless the
operator remembers to pass `--content-root` by hand on every invocation.

Unlike the three sites fixed in this PR, this one does **not** fail silently: the wrong
directory doesn't exist, so `syncPush`/`syncBoth` throw immediately —
`` Content directory not found: content/ (expected at <projectDir>/content) `` — and
`migrate` throws the equivalent `Content directory not found: content/` error. An
operator hits a loud, immediate failure and can work around it with `--content-root`,
rather than the CMS quietly operating on (or missing) the wrong directory. That loud
failure mode is exactly why this was split out instead of bundled with the three silent
bugs: it's real papercut-severity debt, not a data-integrity risk.

## Why this wasn't fixed here

Fixing it properly means the CLI should read `config.contentRoot` from the adopter's
`canopycms.config.ts` when `--content-root` is not explicitly passed, so the flag
becomes an override rather than the only source of truth.

**The loader this needs already exists** — an earlier draft of this file claimed
otherwise, which was wrong. `jiti` is a real runtime `dependencies` entry
(`packages/canopycms/package.json:138`, so it ships with the published CLI bin), and
the CLI already imports adopter `.ts` config with it in **two** places:

- `packages/canopycms/src/cli/generate-ai-content.ts:8,14,32` — loads
  `canopycms.config.ts` and reads `mode`/`contentRoot` off it
- `packages/canopycms/src/cli/init.ts:4,430,433` (`detectMode`, used by
  `worker run-once`) — a near-identical second copy that extracts only `server.mode`

Both hand-roll the same unwrap (`module.default ?? module.config ?? module`, then
`'server' in export ? export.server : export`). So this is not blocked on new
infrastructure; it is a small refactor plus a behaviour decision, and it was split out
of the threading PR only because it is a different kind of change (new precedence
semantics for a user-facing flag + a third consumer of a pattern that should be
factored out first) and because it fails loudly rather than silently.

## Scope

- `packages/canopycms/src/cli/sync.ts:149` — `syncPush`
- `packages/canopycms/src/cli/sync.ts:240` — `syncPull`
- `packages/canopycms/src/cli/sync.ts:364` — `syncBoth`
- `packages/canopycms/src/cli/migrate.ts:186` — `migrate`

## Fix sketch

- **First**, extract the duplicated jiti config-load into one shared helper (something
  like `cli/load-canopy-config.ts` exposing `loadCanopyConfig(projectDir)`), and
  re-point `generate-ai-content.ts` and `init.ts`'s `detectMode` at it. Adding a third
  and fourth inline copy for `sync`/`migrate` is the wrong move.
- In each of the four sites, resolve `contentRoot` as
  `options.contentRoot || loadedConfig?.contentRoot || 'content'` (flag wins, then
  config, then the existing default) instead of skipping straight to the default.
- Decide what a missing/throwing `canopycms.config.ts` should do here. `init.ts:411`
  already documents its own choice (fail loudly rather than silently assume) — the
  sync/migrate paths should either match it or state why they differ, since these
  commands can move content on disk.
- Add regression tests with a project fixture whose `canopycms.config.ts` sets a
  non-default (and a multi-segment) `contentRoot`, run through `sync`/`migrate` with no
  `--content-root` flag, asserting the CLI finds the real content directory.

## Related

- `packages/canopycms/src/schema/schema-store.ts:205-235` — the reference
  `contentRoot`/`contentRootName` pattern this PR's other three fixes follow
- `packages/canopycms/src/config/helpers.ts` — documents `contentRoot` as accepting
  multiple path segments
