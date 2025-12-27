import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { createCanopyServices } from '../services'
import type { ApiContext } from './types'
import { listEntries } from './entries'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-entries-'))

describe('listEntries', () => {
  it('lists entries with access filtering and pagination', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/posts/first.json'),
      JSON.stringify({ title: 'First Post' }),
      'utf8'
    )
    await fs.writeFile(
      path.join(root, 'content/posts/hidden.json'),
      JSON.stringify({ title: 'Hidden Post' }),
      'utf8'
    )
    await fs.writeFile(
      path.join(root, 'content/settings.json'),
      JSON.stringify({ siteName: 'CanopyCMS' }),
      'utf8'
    )

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      schema: [
        {
          type: 'collection',
          name: 'posts',
          path: 'posts',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
        {
          type: 'singleton',
          name: 'settings',
          path: 'settings',
          format: 'json',
          fields: [{ name: 'siteName', type: 'string' }],
        },
      ],
      pathPermissions: [{ path: 'content/posts/hidden.json', allowedUsers: ['other'] }],
    })
    const services = createCanopyServices(config)
    const ctx: ApiContext = {
      services: {
        config,
        checkBranchAccess: services.checkBranchAccess,
        checkContentAccess: services.checkContentAccess,
        bootstrapAdminIds: new Set<string>(),
      },
      getBranchState: vi.fn().mockResolvedValue({
        branch: { name: 'main', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
        workspaceRoot: root,
        baseRoot: root,
        metadataRoot: root,
      }),
    }

    const res = await listEntries(ctx, { user: { userId: 'u1' } }, { branch: 'main', limit: 1 })

    expect(res.ok).toBe(true)
    expect(res.data?.entries.some((e) => e.slug === 'first')).toBe(true)
    expect(res.data?.entries.some((e) => e.slug === 'hidden')).toBe(false)
    const summaries = res.data?.collections ?? []
    const flat = (nodes: typeof summaries): typeof summaries =>
      nodes.flatMap((n) => [n, ...(n.children ? flat(n.children) : [])])
    expect(flat(summaries).find((c) => c.name === 'settings')?.type).toBe('singleton')
    expect(res.data?.pagination.hasMore).toBe(true)
  })

  it('returns 404 when branch is missing', async () => {
    const ctx: ApiContext = {
      services: {
        config: { schema: [] } as any,
        checkBranchAccess: vi.fn(),
        checkContentAccess: vi.fn(),
        bootstrapAdminIds: new Set<string>(),
      },
      getBranchState: vi.fn().mockResolvedValue(null),
    }
    const res = await listEntries(ctx, { user: { userId: 'u1' } }, { branch: 'missing' })
    expect(res.status).toBe(404)
    expect(res.ok).toBe(false)
  })
})
