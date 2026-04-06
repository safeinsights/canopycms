import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'pathe'
import { createEntrySchemaRegistry, validateEntrySchemaRegistry } from './entry-schema-registry'

describe('createEntrySchemaRegistry', () => {
  it('accepts valid schema registry', () => {
    const registry = createEntrySchemaRegistry({
      postSchema: [{ type: 'string', name: 'title', label: 'Title', required: true }],
      authorSchema: [{ type: 'string', name: 'name', label: 'Name', required: true }],
    })

    expect(registry).toBeDefined()
    expect(Object.keys(registry)).toEqual(['postSchema', 'authorSchema'])
  })

  it('throws error for non-object registry', () => {
    expect(() => createEntrySchemaRegistry(null as any)).toThrow(
      'Entry schema registry must be an object',
    )
    expect(() => createEntrySchemaRegistry(undefined as any)).toThrow(
      'Entry schema registry must be an object',
    )
    expect(() => createEntrySchemaRegistry('invalid' as any)).toThrow(
      'Entry schema registry must be an object',
    )
  })

  it('throws error for empty registry', () => {
    expect(() => createEntrySchemaRegistry({})).toThrow('Entry schema registry cannot be empty')
  })

  it('throws error for non-array schema', () => {
    expect(() =>
      createEntrySchemaRegistry({
        postSchema: 'not an array' as any,
      }),
    ).toThrow('Entry schema registry entry "postSchema" must be an array of FieldConfig')
  })

  it('throws error for empty schema array', () => {
    expect(() =>
      createEntrySchemaRegistry({
        postSchema: [],
      }),
    ).toThrow('Entry schema registry entry "postSchema" cannot be empty')
  })

  it('throws error for multiple isTitle fields', () => {
    expect(() =>
      createEntrySchemaRegistry({
        postSchema: [
          { type: 'string', name: 'heading', isTitle: true },
          { type: 'string', name: 'subtitle', isTitle: true },
        ],
      }),
    ).toThrow('has 2 fields with isTitle: true, but at most one is allowed')
  })

  it('throws error for isTitle on non-string field', () => {
    expect(() =>
      createEntrySchemaRegistry({
        postSchema: [
          { type: 'number', name: 'order', isTitle: true },
          { type: 'string', name: 'title' },
        ],
      }),
    ).toThrow('isTitle is only valid on string fields')
  })

  it('throws error for isTitle inside a list object field', () => {
    expect(() =>
      createEntrySchemaRegistry({
        postSchema: [
          {
            type: 'object',
            name: 'items',
            list: true,
            fields: [{ type: 'string', name: 'title', isTitle: true }],
          },
        ],
      }),
    ).toThrow('isTitle cannot resolve inside list fields')
  })

  it('accepts isTitle inside a non-list object field', () => {
    const registry = createEntrySchemaRegistry({
      postSchema: [
        {
          type: 'object',
          name: 'hero',
          fields: [{ type: 'string', name: 'heading', isTitle: true }],
        },
      ],
    })
    expect(registry).toBeDefined()
  })

  it('accepts a single isBody field with markdown type', () => {
    const registry = createEntrySchemaRegistry({
      postSchema: [
        { type: 'string', name: 'title' },
        { type: 'markdown', name: 'body', isBody: true },
      ],
    })
    expect(registry).toBeDefined()
  })

  it('accepts a single isBody field with mdx type', () => {
    const registry = createEntrySchemaRegistry({
      postSchema: [
        { type: 'string', name: 'title' },
        { type: 'mdx', name: 'content', isBody: true },
      ],
    })
    expect(registry).toBeDefined()
  })

  it('throws error for multiple isBody fields', () => {
    expect(() =>
      createEntrySchemaRegistry({
        postSchema: [
          { type: 'markdown', name: 'body', isBody: true },
          { type: 'markdown', name: 'content', isBody: true },
        ],
      }),
    ).toThrow('has 2 fields with isBody: true, but at most one is allowed')
  })

  it('throws error for isBody on non-markdown field', () => {
    expect(() =>
      createEntrySchemaRegistry({
        postSchema: [
          { type: 'string', name: 'body', isBody: true },
          { type: 'string', name: 'title' },
        ],
      }),
    ).toThrow('isBody is only valid on markdown or mdx fields')
  })
})

describe('validateEntrySchemaRegistry', () => {
  const testDir = join(process.cwd(), '.test-content-validate')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('validates registry with matching schema references', async () => {
    const registry = {
      postSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
    }

    // Create a collection that references postSchema
    await mkdir(join(testDir, 'posts'), { recursive: true })
    await writeFile(
      join(testDir, 'posts', '.collection.json'),
      JSON.stringify({
        name: 'posts',
        entries: [
          {
            name: 'post',
            format: 'mdx',
            schema: 'postSchema',
          },
        ],
        order: [],
      }),
    )

    await expect(validateEntrySchemaRegistry(registry, testDir)).resolves.toBeUndefined()
  })

  it('throws error for missing schema reference in collection', async () => {
    const registry = {
      postSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
    }

    // Create a collection that references non-existent schema
    await mkdir(join(testDir, 'posts'), { recursive: true })
    await writeFile(
      join(testDir, 'posts', '.collection.json'),
      JSON.stringify({
        name: 'posts',
        entries: [
          {
            name: 'post',
            format: 'mdx',
            schema: 'authorSchema',
          },
        ],
        order: [],
      }),
    )

    await expect(validateEntrySchemaRegistry(registry, testDir)).rejects.toThrow(
      /Entry type "post" in collection "posts".*references entry schema "authorSchema".*does not exist/,
    )
    await expect(validateEntrySchemaRegistry(registry, testDir)).rejects.toThrow(
      /Available: postSchema/,
    )
  })

  it('throws error for missing schema reference in root entry type', async () => {
    const registry = {
      postSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
    }

    // Create root collection with entry type referencing non-existent schema
    await writeFile(
      join(testDir, '.collection.json'),
      JSON.stringify({
        entries: [
          {
            name: 'home',
            format: 'json',
            schema: 'homeSchema',
          },
        ],
        order: [],
      }),
    )

    await expect(validateEntrySchemaRegistry(registry, testDir)).rejects.toThrow(
      /Root entry type "home".*references entry schema "homeSchema".*does not exist/,
    )
  })

  it('throws error for missing schema reference in collection entry type', async () => {
    const registry = {
      postSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
    }

    // Create collection with entry type referencing non-existent schema
    await mkdir(join(testDir, 'docs'), { recursive: true })
    await writeFile(
      join(testDir, 'docs', '.collection.json'),
      JSON.stringify({
        name: 'docs',
        entries: [
          {
            name: 'doc',
            format: 'json',
            schema: 'configSchema',
          },
        ],
        order: [],
      }),
    )

    await expect(validateEntrySchemaRegistry(registry, testDir)).rejects.toThrow(
      /Entry type "doc" in collection "docs".*references entry schema "configSchema".*does not exist/,
    )
  })

  it('validates nested collections correctly', async () => {
    const registry = {
      postSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
      docSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
    }

    // Create nested collections
    await mkdir(join(testDir, 'docs', 'api'), { recursive: true })
    await writeFile(
      join(testDir, 'docs', '.collection.json'),
      JSON.stringify({
        name: 'docs',
        entries: [
          {
            name: 'doc',
            format: 'mdx',
            schema: 'docSchema',
          },
        ],
        order: [],
      }),
    )
    await writeFile(
      join(testDir, 'docs', 'api', '.collection.json'),
      JSON.stringify({
        name: 'api',
        entries: [
          {
            name: 'doc',
            format: 'mdx',
            schema: 'docSchema',
          },
        ],
        order: [],
      }),
    )

    await expect(validateEntrySchemaRegistry(registry, testDir)).resolves.toBeUndefined()
  })

  it('throws error for non-existent content directory', async () => {
    const registry = {
      postSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
    }

    await expect(validateEntrySchemaRegistry(registry, '/nonexistent')).rejects.toThrow(
      /Content directory not found/,
    )
  })

  it('validates with no .collection.json files (empty content dir)', async () => {
    const registry = {
      postSchema: [
        {
          type: 'string' as const,
          name: 'title',
          label: 'Title',
          required: true,
        },
      ],
    }

    await expect(validateEntrySchemaRegistry(registry, testDir)).resolves.toBeUndefined()
  })
})
