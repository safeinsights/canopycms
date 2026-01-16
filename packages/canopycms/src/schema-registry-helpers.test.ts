import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'pathe'
import { createSchemaRegistry, validateSchemaRegistry } from './schema-registry-helpers'

describe('createSchemaRegistry', () => {
  it('accepts valid schema registry', () => {
    const registry = createSchemaRegistry({
      postSchema: [{ type: 'text', name: 'title', label: 'Title', required: true }],
      authorSchema: [{ type: 'text', name: 'name', label: 'Name', required: true }],
    })

    expect(registry).toBeDefined()
    expect(Object.keys(registry)).toEqual(['postSchema', 'authorSchema'])
  })

  it('throws error for non-object registry', () => {
    expect(() => createSchemaRegistry(null as any)).toThrow('Schema registry must be an object')
    expect(() => createSchemaRegistry(undefined as any)).toThrow(
      'Schema registry must be an object',
    )
    expect(() => createSchemaRegistry('invalid' as any)).toThrow(
      'Schema registry must be an object',
    )
  })

  it('throws error for empty registry', () => {
    expect(() => createSchemaRegistry({})).toThrow('Schema registry cannot be empty')
  })

  it('throws error for non-array schema', () => {
    expect(() =>
      createSchemaRegistry({
        postSchema: 'not an array' as any,
      }),
    ).toThrow('Schema registry entry "postSchema" must be an array of FieldConfig')
  })

  it('throws error for empty schema array', () => {
    expect(() =>
      createSchemaRegistry({
        postSchema: [],
      }),
    ).toThrow('Schema registry entry "postSchema" cannot be empty')
  })
})

describe('validateSchemaRegistry', () => {
  const testDir = join(process.cwd(), '.test-content-validate')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('validates registry with matching schema references', async () => {
    const registry = {
      postSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
    }

    // Create a collection that references postSchema
    await mkdir(join(testDir, 'posts'), { recursive: true })
    await writeFile(
      join(testDir, 'posts', '.collection.json'),
      JSON.stringify({
        name: 'posts',
        entries: {
          format: 'mdx',
          fields: 'postSchema',
        },
      }),
    )

    await expect(validateSchemaRegistry(registry, testDir)).resolves.toBeUndefined()
  })

  it('throws error for missing schema reference in collection', async () => {
    const registry = {
      postSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
    }

    // Create a collection that references non-existent schema
    await mkdir(join(testDir, 'posts'), { recursive: true })
    await writeFile(
      join(testDir, 'posts', '.collection.json'),
      JSON.stringify({
        name: 'posts',
        entries: {
          format: 'mdx',
          fields: 'authorSchema',
        },
      }),
    )

    await expect(validateSchemaRegistry(registry, testDir)).rejects.toThrow(
      /Collection "posts".*references schema "authorSchema".*does not exist/,
    )
    await expect(validateSchemaRegistry(registry, testDir)).rejects.toThrow(/Available: postSchema/)
  })

  it('throws error for missing schema reference in root singleton', async () => {
    const registry = {
      postSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
    }

    // Create root collection with singleton referencing non-existent schema
    await writeFile(
      join(testDir, '.collection.json'),
      JSON.stringify({
        singletons: [
          {
            name: 'home',
            path: 'home.json',
            format: 'json',
            fields: 'homeSchema',
          },
        ],
      }),
    )

    await expect(validateSchemaRegistry(registry, testDir)).rejects.toThrow(
      /Root singleton "home".*references schema "homeSchema".*does not exist/,
    )
  })

  it('throws error for missing schema reference in collection singleton', async () => {
    const registry = {
      postSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
    }

    // Create collection with singleton referencing non-existent schema
    await mkdir(join(testDir, 'docs'), { recursive: true })
    await writeFile(
      join(testDir, 'docs', '.collection.json'),
      JSON.stringify({
        name: 'docs',
        singletons: [
          {
            name: 'config',
            path: 'config.json',
            format: 'json',
            fields: 'configSchema',
          },
        ],
      }),
    )

    await expect(validateSchemaRegistry(registry, testDir)).rejects.toThrow(
      /Singleton "config" in collection "docs".*references schema "configSchema".*does not exist/,
    )
  })

  it('validates nested collections correctly', async () => {
    const registry = {
      postSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
      docSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
    }

    // Create nested collections
    await mkdir(join(testDir, 'docs', 'api'), { recursive: true })
    await writeFile(
      join(testDir, 'docs', '.collection.json'),
      JSON.stringify({
        name: 'docs',
        entries: {
          format: 'mdx',
          fields: 'docSchema',
        },
      }),
    )
    await writeFile(
      join(testDir, 'docs', 'api', '.collection.json'),
      JSON.stringify({
        name: 'api',
        entries: {
          format: 'mdx',
          fields: 'docSchema',
        },
      }),
    )

    await expect(validateSchemaRegistry(registry, testDir)).resolves.toBeUndefined()
  })

  it('throws error for non-existent content directory', async () => {
    const registry = {
      postSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
    }

    await expect(validateSchemaRegistry(registry, '/nonexistent')).rejects.toThrow(
      /Content directory not found/,
    )
  })

  it('validates with no .collection.json files (empty content dir)', async () => {
    const registry = {
      postSchema: [{ type: 'text' as const, name: 'title', label: 'Title', required: true }],
    }

    await expect(validateSchemaRegistry(registry, testDir)).resolves.toBeUndefined()
  })
})
