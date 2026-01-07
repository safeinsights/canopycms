import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContentIdIndex } from './content-id-index'

describe('ContentIdIndex', () => {
  let tempDir: string
  let index: ContentIdIndex

  beforeEach(async () => {
    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-test-'))
    await fs.mkdir(path.join(tempDir, 'content'), { recursive: true })
    index = new ContentIdIndex(tempDir)
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe('buildFromSymlinks', () => {
    it('finds no symlinks in empty directory', async () => {
      await index.buildFromSymlinks('content')

      expect(index.findById('anyid')).toBeNull()
    })

    it('builds index from existing symlinks', async () => {
      // Create a test file
      const filePath = path.join(tempDir, 'content/test.json')
      await fs.writeFile(filePath, '{}')

      // Manually create symlink in _ids_
      await fs.mkdir(path.join(tempDir, 'content/_ids_'), { recursive: true })
      const testId = 'test123ABC456def789ghi'
      await fs.symlink('../test.json', path.join(tempDir, 'content/_ids_', testId), 'file')

      // Build index
      await index.buildFromSymlinks('content')

      // Verify
      const location = index.findById(testId)
      expect(location).not.toBeNull()
      expect(location?.id).toBe(testId)
      expect(location?.type).toBe('entry')
      expect(location?.relativePath).toBe('content/test.json')
    })

    it('indexes multiple entries', async () => {
      // Create files
      await fs.writeFile(path.join(tempDir, 'content/home.json'), '{}')
      await fs.writeFile(path.join(tempDir, 'content/about.json'), '{}')

      // Create symlinks
      await fs.mkdir(path.join(tempDir, 'content/_ids_'), { recursive: true })
      const homeId = 'homeABC123def456ghi789'
      const aboutId = 'aboutXYZ789abc123def456'

      await fs.symlink('../home.json', path.join(tempDir, 'content/_ids_', homeId), 'file')
      await fs.symlink('../about.json', path.join(tempDir, 'content/_ids_', aboutId), 'file')

      // Build index
      await index.buildFromSymlinks('content')

      // Verify all entries
      const homeLocation = index.findById(homeId)
      expect(homeLocation).not.toBeNull()
      expect(homeLocation?.type).toBe('entry')
      expect(homeLocation?.slug).toBe('home')

      const aboutLocation = index.findById(aboutId)
      expect(aboutLocation).not.toBeNull()
      expect(aboutLocation?.type).toBe('entry')
      expect(aboutLocation?.slug).toBe('about')
    })
  })

  describe('findById', () => {
    it('returns null for non-existent ID', async () => {
      await index.buildFromSymlinks('content')
      expect(index.findById('nonexistent')).toBeNull()
    })

    it('returns location for existing ID', async () => {
      // Setup
      await fs.writeFile(path.join(tempDir, 'content/test.json'), '{}')
      await fs.mkdir(path.join(tempDir, 'content/_ids_'), { recursive: true })
      const testId = 'testABC123def456ghi789'
      await fs.symlink('../test.json', path.join(tempDir, 'content/_ids_', testId), 'file')
      await index.buildFromSymlinks('content')

      // Test
      const location = index.findById(testId)
      expect(location).toMatchObject({
        id: testId,
        type: 'entry',
        relativePath: 'content/test.json'
      })
    })
  })

  describe('findByPath', () => {
    it('returns null for non-existent path', async () => {
      await index.buildFromSymlinks('content')
      expect(index.findByPath('content/nonexistent.json')).toBeNull()
    })

    it('returns ID for existing path', async () => {
      // Setup
      await fs.writeFile(path.join(tempDir, 'content/test.json'), '{}')
      await fs.mkdir(path.join(tempDir, 'content/_ids_'), { recursive: true })
      const testId = 'testABC123def456ghi789'
      await fs.symlink('../test.json', path.join(tempDir, 'content/_ids_', testId), 'file')
      await index.buildFromSymlinks('content')

      // Test
      const id = index.findByPath('content/test.json')
      expect(id).toBe(testId)
    })
  })

  describe('add', () => {
    it('creates symlink and updates index', async () => {
      // Create file
      await fs.writeFile(path.join(tempDir, 'content/new.json'), '{}')

      // Add to index
      const id = await index.add({
        type: 'entry',
        relativePath: 'content/new.json',
        collection: '',
        slug: 'new'
      })

      // Verify ID was generated
      expect(id).toHaveLength(22)

      // Verify symlink exists
      const symlinkPath = path.join(tempDir, 'content/_ids_', id)
      const stat = await fs.lstat(symlinkPath)
      expect(stat.isSymbolicLink()).toBe(true)

      // Verify index updated
      expect(index.findById(id)).not.toBeNull()
      expect(index.findByPath('content/new.json')).toBe(id)
    })

    it('returns existing ID if path already indexed', async () => {
      await fs.writeFile(path.join(tempDir, 'content/existing.json'), '{}')

      const id1 = await index.add({
        type: 'entry',
        relativePath: 'content/existing.json',
        collection: '',
        slug: 'existing'
      })

      const id2 = await index.add({
        type: 'entry',
        relativePath: 'content/existing.json',
        collection: '',
        slug: 'existing'
      })

      expect(id1).toBe(id2)
    })

    it('creates collection symlinks', async () => {
      await fs.mkdir(path.join(tempDir, 'content/posts'), { recursive: true })

      const id = await index.add({
        type: 'collection',
        relativePath: 'content/posts'
      })

      // Verify symlink is a directory link
      const symlinkPath = path.join(tempDir, 'content/_ids_', id)
      const target = await fs.readlink(symlinkPath)
      expect(target).toBe('../posts')
    })
  })

  describe('remove', () => {
    it('deletes symlink and updates index', async () => {
      // Setup
      await fs.writeFile(path.join(tempDir, 'content/test.json'), '{}')
      const id = await index.add({
        type: 'entry',
        relativePath: 'content/test.json',
        collection: '',
        slug: 'test'
      })

      // Remove
      await index.remove(id)

      // Verify symlink deleted
      const symlinkPath = path.join(tempDir, 'content/_ids_', id)
      await expect(fs.access(symlinkPath)).rejects.toThrow()

      // Verify index updated
      expect(index.findById(id)).toBeNull()
      expect(index.findByPath('content/test.json')).toBeNull()
    })

    it('handles non-existent ID gracefully', async () => {
      await expect(index.remove('nonexistent')).resolves.not.toThrow()
    })
  })
})
