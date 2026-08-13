import fs from 'node:fs/promises'
import path from 'node:path'
// Isomorphic/dependency-free module (see its own doc comment) -- safe to
// import directly in test code, same convention test-workspace.ts already
// uses for other package internals (e.g. resource-generation.ts).
import { ASSET_PREFIXES } from '../../../../packages/canopycms/src/assets/asset-prefixes'

const TEST_APP_ROOT = path.resolve(process.cwd(), 'apps/test-app')

/**
 * Dev-mode LocalAssetStore root. Mirrors context-wrapper.ts's
 * `devAssetsDir` computation (`getWorkspaceRoot()/assets`, i.e.
 * `{cwd}/.canopy-dev/assets`) -- these fixtures run from the repo root while
 * the dev server's cwd is apps/test-app, hence the explicit join (same
 * pattern test-workspace.ts/admin-workspace.ts use for their own dirs).
 */
const ASSETS_ROOT = path.join(TEST_APP_ROOT, '.canopy-dev/assets')

/**
 * Every top-level bucket LocalAssetStore writes under its root (see
 * asset-prefixes.ts). `ASSET_PREFIXES.transform` ('assets/t') nests inside
 * `ASSET_PREFIXES.public` ('assets'), so removing `public` also removes every
 * transform output -- no separate entry needed.
 */
const ASSET_SUBDIRS = [
  ASSET_PREFIXES.originals,
  ASSET_PREFIXES.staging,
  ASSET_PREFIXES.meta,
  ASSET_PREFIXES.public,
] as const

export function getAssetsRoot(): string {
  return ASSETS_ROOT
}

/**
 * Delete all asset-store state: originals, staging, meta, and every public
 * object (sanitized svg/pdf + every cached transform output).
 *
 * `resetWorkspace()` in test-workspace.ts only resets `content-branches/`
 * (git-backed entry content); the asset store is a separate, branch-agnostic
 * global store (see assets/factory.ts) that lives beside it under
 * `.canopy-dev/assets` and is untouched by that reset. Without this, uploaded
 * assets would accumulate across tests AND across whole suite runs (the
 * state-leak proof runs the suite twice without wiping `.canopy-dev`). Called
 * from `resetWorkspace()` so every spec inherits it, mirroring how
 * `resetTaskQueue()` (admin-workspace.ts) is wired in for the task queue.
 */
export async function resetAssetStore(): Promise<void> {
  await Promise.all(
    ASSET_SUBDIRS.map((dir) =>
      fs.rm(path.join(ASSETS_ROOT, dir), { recursive: true, force: true }),
    ),
  )
}

/** hash32 values for every asset currently in the store (from `asset-meta/*.json` filenames). */
export async function listAssetHashes(): Promise<string[]> {
  const dir = path.join(ASSETS_ROOT, ASSET_PREFIXES.meta)
  const files = await fs.readdir(dir).catch(() => [] as string[])
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
}

/**
 * True if a finalized original blob exists for `hash32` under
 * `asset-originals/` (LocalAssetStore.readOriginal matches by `{hash32}.`
 * prefix since the extension varies by upload).
 */
export async function assetOriginalExists(hash32: string): Promise<boolean> {
  const dir = path.join(ASSETS_ROOT, ASSET_PREFIXES.originals)
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  return entries.some((name) => name.startsWith(`${hash32}.`))
}

/**
 * Delete the finalized original blob(s) for `hash32` from `asset-originals/`.
 *
 * Used to prove a transform is served FROM THE DISK CACHE rather than
 * recomputed: the raw-asset route checks the public object store first and
 * only falls through to `serveLazyTransform` (which needs the original) on a
 * miss — so once the original is gone, a 200 can only come from the cache,
 * and a broken cache path turns into a 404. Deleting only the original keeps
 * `asset-meta/` intact, so nothing else about the asset record changes.
 */
export async function removeAssetOriginals(hash32: string): Promise<void> {
  const dir = path.join(ASSETS_ROOT, ASSET_PREFIXES.originals)
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter((name) => name.startsWith(`${hash32}.`))
      .map((name) => fs.rm(path.join(dir, name), { force: true })),
  )
}

/**
 * Directive-string subdirectories materialized on disk for `hash32` under
 * `assets/t/{directives}/{hash32}/` (e.g. `['orig', 'w=320']`) -- one entry
 * per distinct transform variant that has actually been requested and
 * cached. Used to prove the lazy transform emulation (api/assets.ts's
 * `serveLazyTransform`) writes its output back under the canonical key.
 */
export async function listTransformDirs(hash32: string): Promise<string[]> {
  const transformRoot = path.join(ASSETS_ROOT, ASSET_PREFIXES.transform)
  const directiveDirs = await fs.readdir(transformRoot, { withFileTypes: true }).catch(() => [])
  const matches: string[] = []
  for (const entry of directiveDirs) {
    if (!entry.isDirectory()) continue
    const exists = await fs
      .access(path.join(transformRoot, entry.name, hash32))
      .then(() => true)
      .catch(() => false)
    if (exists) matches.push(entry.name)
  }
  return matches
}
