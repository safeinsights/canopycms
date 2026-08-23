import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STATIC_DEPLOY_USER } from './build-mode'
import { createTestServices } from './config-test'
import { createCanopyContext } from './context'
import { loadCollectionMetaFiles, resolveCollectionReferences } from './schema/meta-loader'
import { collectUrlExclusivityReport } from './url-exclusivity-fixtures'
import type { EntrySchemaRegistry } from './schema/types'
import type { BranchContext } from './types'

// ---------------------------------------------------------------------------
// The reference app answers at exactly the URLs it publishes
// ---------------------------------------------------------------------------
//
// url-exclusivity.test.ts asserts the invariant over hand-built fixtures chosen to exercise it.
// This one asserts it over `apps/example1`'s REAL content tree and REAL `.collection.json`
// schema, because the fixtures are chosen by whoever is thinking about the invariant and the
// reference app is not: it grows entries and entry types for unrelated reasons, and every one of
// those is a chance to reintroduce a phantom URL that no fixture happens to model.
//
// It was not hypothetical. Before the fix this app served SEVEN duplicate doc pages --
// /docs/doc/overview, /docs/api/doc/intro, /docs/api/v1/doc/authentication and siblings -- all
// through its live `app/docs/[[...slug]]` catch-all, which has `dynamicParams = true` and no
// entryType gate. `next build` stayed green throughout, and the sitemap never mentioned them, so
// nothing in CI could see it.
//
// Lives in the package rather than in apps/example1 so the example app gains no new import of
// CanopyCMS (AGENTS.md's touchpoint rule): it reads that app's content as DATA, and depends on
// none of its code.

const here = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE1_CONTENT = path.resolve(here, '../../../apps/example1/content')

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-example1-urls-'))

const buildBranchContext = (branchRoot: string): BranchContext => {
  const now = new Date().toISOString()
  return {
    baseRoot: branchRoot,
    branchRoot,
    branch: {
      name: 'main',
      status: 'editing',
      access: {},
      createdBy: 'tester',
      createdAt: now,
      updatedAt: now,
    },
  }
}

let testBranchContext: BranchContext
vi.mock('./branch-workspace', () => ({
  loadOrCreateBranchContext: async () => testBranchContext,
  loadBranchContext: async () => testBranchContext,
}))

/**
 * Resolve example1's on-disk `.collection.json` tree into a RootCollectionConfig.
 *
 * The entry FIELD schemas live in `apps/example1/app/schemas.ts` and are referenced by name; this
 * suite substitutes an empty field list for each name it finds rather than importing that module,
 * which would be the touchpoint this file exists to avoid. URL exclusivity is decided entirely by
 * collection paths, entry-type names and slugs, none of which come from the field schemas.
 * Discovering the names from the meta files rather than hardcoding them keeps this from rotting
 * when the example app gains an entry type.
 */
const loadExample1Schema = async (contentRoot: string) => {
  const metaFiles = await loadCollectionMetaFiles(contentRoot)
  const registry: EntrySchemaRegistry = {}
  const collectRefs = (entries: ReadonlyArray<{ schema?: unknown }> | undefined) => {
    for (const entry of entries ?? []) {
      if (typeof entry.schema === 'string') registry[entry.schema] = []
    }
  }
  collectRefs(metaFiles.root?.entries)
  for (const collection of metaFiles.collections) collectRefs(collection.entries)
  return resolveCollectionReferences(metaFiles, registry)
}

describe('apps/example1 resolves exactly the URLs it publishes', () => {
  let root: string

  beforeEach(async () => {
    root = await tmpDir()
    testBranchContext = buildBranchContext(root)
    // Copied, not read in place: a read builds the ContentId index, which persists a generation
    // marker under `.canopy-meta/`. Pointing a store at the working tree would write into the
    // repo as a side effect of running the suite.
    await fs.cp(EXAMPLE1_CONTENT, path.join(root, 'content'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('publishes and resolves the same set, with no phantom URLs', async () => {
    const schema = await loadExample1Schema(path.join(root, 'content'))
    const services = await createTestServices(
      { defaultBranchAccess: 'allow', defaultPathAccess: 'allow', schema },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )
    const ctx = await createCanopyContext({
      services,
      extractUser: async () => STATIC_DEPLOY_USER,
    }).getContext()

    const report = await collectUrlExclusivityReport(ctx, schema)

    // Anti-vacuity: the copy really has content and the real schema really parsed. Asserted as a
    // floor plus two landmarks rather than the exact list, so adding a doc page to the example
    // app does not fail this suite -- renaming one of these two still does, and should.
    expect(report.published.length).toBeGreaterThanOrEqual(10)
    expect(report.published).toEqual(expect.arrayContaining(['/', '/docs/overview']))

    // Anti-vacuity: the probe generator reached the URLs this app actually regressed on. `home`
    // and `doc` are declared entry-type names in example1's `.collection.json` files; each of
    // these resolved a real page before the collection gate landed.
    expect(report.probes).toEqual(
      expect.arrayContaining([
        '/home',
        '/docs/doc',
        '/docs/doc/overview',
        '/docs/api/doc/intro',
        '/docs/guides/doc/getting-started',
      ]),
    )

    expect(report.duplicates).toEqual([])
    expect(report.unresolved).toEqual([])
    expect(report.mismatched).toEqual([])
    expect(report.phantoms).toEqual([])
  })
})
