import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { LocalAssetStore } from './asset-store'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-assets-'))

describe('LocalAssetStore', () => {
  it('uploads, lists, and deletes assets', async () => {
    const root = await tmpDir()
    const store = new LocalAssetStore({
      root,
      publicBaseUrl: 'https://cdn.test',
    })

    const uploaded = await store.upload('images/foo.png', Buffer.from('hello'), 'image/png')
    expect(uploaded.key).toBe('images/foo.png')
    expect(uploaded.url).toBe('https://cdn.test/images/foo.png')

    const items = await store.list('images')
    expect(items).toHaveLength(1)
    expect(items[0].key).toBe('images/foo.png')

    await store.delete('images/foo.png')
    const afterDelete = await store.list('images')
    expect(afterDelete).toHaveLength(0)
  })

  it('prevents path traversal', async () => {
    const root = await tmpDir()
    const store = new LocalAssetStore({ root })
    await expect(store.upload('../evil.txt', Buffer.from('x'))).rejects.toBeInstanceOf(Error)
  })
})
