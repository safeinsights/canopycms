/**
 * The serving editor's schema-registry record (schema-registry-record.ts), which the worker's
 * schema gate reads.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { createCanopyRequestHandler } from './http/handler'
import { registryFingerprint } from './schema/registry-fingerprint'
import {
  SCHEMA_REGISTRY_RECORD,
  readSchemaRegistryRecord,
  recordSchemaRegistry,
  recordServedSchemaRegistry,
} from './schema-registry-record'
import type { EntrySchemaRegistry } from './schema/types'
import type { CanopyServices } from './services'
import { mockConsole, type MockConsole } from './test-utils'

let tmpDir: string
let workspaceRoot: string
let branchesRoot: string
let consoleSpy: MockConsole

const BUILD = { canopycmsVersion: '1.2.3', sourceRevision: 'abc123' }

const REGISTRY: EntrySchemaRegistry = {
  postSchema: [{ name: 'title', type: 'string' }],
  personSchema: [{ name: 'name', type: 'string' }],
}

beforeEach(async () => {
  consoleSpy = mockConsole()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-schema-record-'))
  workspaceRoot = path.join(tmpDir, 'ws')
  branchesRoot = path.join(workspaceRoot, 'content-branches')
  await fs.mkdir(branchesRoot, { recursive: true })
  vi.stubEnv('CANOPYCMS_WORKSPACE_ROOT', workspaceRoot)
})

afterEach(async () => {
  consoleSpy.restore()
  vi.unstubAllEnvs()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function prodConfig(contentRoot?: string) {
  return defineCanopyTestConfig({
    mode: 'prod',
    defaultBaseBranch: 'main',
    deploymentName: 'test',
    schema: { collections: [] },
    ...(contentRoot === undefined ? {} : { contentRoot }),
  })
}

describe('recordSchemaRegistry / readSchemaRegistryRecord', () => {
  it('round-trips a record with the names sorted', async () => {
    await recordSchemaRegistry(branchesRoot, {
      schemas: ['zeta', 'alpha'],
      fingerprint: 'fp-1',
      contentRoot: 'content',
      build: BUILD,
    })

    const record = await readSchemaRegistryRecord(branchesRoot)
    expect(record).toMatchObject({
      version: 1,
      schemas: ['alpha', 'zeta'],
      fingerprint: 'fp-1',
      contentRoot: 'content',
      build: BUILD,
    })
    expect(Number.isNaN(Date.parse(record?.recordedAt ?? ''))).toBe(false)
  })

  it('leaves an identical record untouched, and replaces a different one', async () => {
    const entry = { schemas: ['a', 'b'], fingerprint: 'fp-1', contentRoot: 'content', build: BUILD }
    await recordSchemaRegistry(branchesRoot, entry)
    const first = await readSchemaRegistryRecord(branchesRoot)

    await new Promise((resolve) => setTimeout(resolve, 5))
    await recordSchemaRegistry(branchesRoot, { ...entry })
    expect((await readSchemaRegistryRecord(branchesRoot))?.recordedAt).toBe(first?.recordedAt)

    // Each step differs from the record in ONE field, so each comparison is pinned on its own.
    const refingerprinted = { ...entry, schemas: ['a'], fingerprint: 'fp-2' }
    await recordSchemaRegistry(branchesRoot, refingerprinted)
    expect((await readSchemaRegistryRecord(branchesRoot))?.schemas).toEqual(['a'])

    const moved = { ...refingerprinted, contentRoot: 'site/content' }
    await recordSchemaRegistry(branchesRoot, moved)
    expect((await readSchemaRegistryRecord(branchesRoot))?.contentRoot).toBe('site/content')

    const rebuilt = { ...moved, build: { ...BUILD, sourceRevision: 'def456' } }
    await recordSchemaRegistry(branchesRoot, rebuilt)
    expect((await readSchemaRegistryRecord(branchesRoot))?.build.sourceRevision).toBe('def456')

    await recordSchemaRegistry(branchesRoot, {
      ...rebuilt,
      build: { ...rebuilt.build, canopycmsVersion: '9.9.9' },
    })
    expect((await readSchemaRegistryRecord(branchesRoot))?.build.canopycmsVersion).toBe('9.9.9')
  })

  it('reads no record from a missing, unparseable or wrongly shaped file', async () => {
    expect(await readSchemaRegistryRecord(branchesRoot)).toBeUndefined()

    const file = path.join(branchesRoot, SCHEMA_REGISTRY_RECORD)
    await fs.writeFile(file, '{not json')
    expect(await readSchemaRegistryRecord(branchesRoot)).toBeUndefined()

    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        schemas: 'post',
        fingerprint: 'fp-1',
        contentRoot: 'content',
        build: BUILD,
        recordedAt: '2026-10-09T00:00:00.000Z',
      }),
    )
    expect(await readSchemaRegistryRecord(branchesRoot)).toBeUndefined()

    await fs.writeFile(
      file,
      JSON.stringify({
        version: 2,
        schemas: ['post'],
        fingerprint: 'fp-1',
        contentRoot: 'content',
        build: BUILD,
        recordedAt: '2026-10-09T00:00:00.000Z',
      }),
    )
    expect(await readSchemaRegistryRecord(branchesRoot)).toBeUndefined()
  })

  it('creates nothing when the branches root does not exist', async () => {
    const missing = path.join(tmpDir, 'absent')
    await recordSchemaRegistry(missing, {
      schemas: ['a'],
      fingerprint: 'fp-1',
      contentRoot: 'content',
      build: BUILD,
    })
    await expect(fs.access(missing)).rejects.toThrow()
  })
})

describe('recordServedSchemaRegistry', () => {
  it("records the registry's names and the configured content root", async () => {
    await recordServedSchemaRegistry(prodConfig('cms/content'), REGISTRY)

    expect(await readSchemaRegistryRecord(branchesRoot)).toMatchObject({
      schemas: ['personSchema', 'postSchema'],
      fingerprint: registryFingerprint(REGISTRY),
      contentRoot: 'cms/content',
    })
  })

  it('records nothing for an empty registry, which speaks for no editor', async () => {
    await recordServedSchemaRegistry(prodConfig(), {})
    expect(await readSchemaRegistryRecord(branchesRoot)).toBeUndefined()
  })

  it('records nothing during a build', async () => {
    vi.stubEnv('CANOPY_BUILD_MODE', 'true')
    await recordServedSchemaRegistry(prodConfig(), REGISTRY)
    expect(await readSchemaRegistryRecord(branchesRoot)).toBeUndefined()
  })

  it('logs instead of throwing when the record cannot be written', async () => {
    await fs.writeFile(path.join(branchesRoot, SCHEMA_REGISTRY_RECORD), '{}')
    await fs.chmod(branchesRoot, 0o500)
    try {
      await expect(recordServedSchemaRegistry(prodConfig(), REGISTRY)).resolves.toBeUndefined()
    } finally {
      await fs.chmod(branchesRoot, 0o700)
    }
    expect(consoleSpy).toHaveWarned('Could not record the entry schema registry')
  })

  it('records the registry when the API handler starts', async () => {
    const handler = createCanopyRequestHandler({
      services: {
        config: prodConfig(),
        entrySchemaRegistry: REGISTRY,
        refreshActiveBranch: async () => {},
        resolvePendingBaseBranch: async () => {},
      } as unknown as CanopyServices,
      authPlugin: {
        verifiesCredentials: true,
        authenticate: async () => ({ success: false, error: 'Unauthorized' }),
        searchUsers: async () => [],
        getUserMetadata: async () => null,
        getGroupMetadata: async () => null,
        listGroups: async () => [],
      },
    })

    const response = await handler(
      {
        method: 'GET',
        url: 'http://localhost/api/canopycms/branches',
        header: () => null,
        json: async () => undefined,
      },
      ['branches'],
    )

    expect(response.status).toBe(401)
    expect((await readSchemaRegistryRecord(branchesRoot))?.schemas).toEqual([
      'personSchema',
      'postSchema',
    ])
  })
})
