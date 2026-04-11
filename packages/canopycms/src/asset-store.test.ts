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

  it('prevents sibling-directory bypass via prefix-only startsWith check', async () => {
    // Root: /tmp/canopycms-XYZ/assets
    // Sibling: /tmp/canopycms-XYZ/assets-sibling  ← starts with "assets" but is outside root
    // A key of "../assets-sibling/file" resolves to the sibling dir, which naively passes
    // startsWith(root) because "assets-sibling" starts with "assets".
    const parent = await tmpDir()
    const root = path.join(parent, 'assets')
    const sibling = path.join(parent, 'assets-sibling')
    await fs.mkdir(root)
    await fs.mkdir(sibling)
    await fs.writeFile(path.join(sibling, 'secret.txt'), 'secret content')

    const store = new LocalAssetStore({ root })

    await expect(store.list('../assets-sibling')).rejects.toThrow('Path traversal detected')
    await expect(store.upload('../assets-sibling/evil.txt', Buffer.from('x'))).rejects.toThrow(
      'Path traversal detected',
    )
    await expect(store.delete('../assets-sibling/secret.txt')).rejects.toThrow(
      'Path traversal detected',
    )
  })
})
