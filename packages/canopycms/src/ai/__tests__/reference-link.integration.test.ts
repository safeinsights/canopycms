import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema } from '../../config'
import { ContentStore } from '../../content-store'
import { extractIdFromFilename } from '../../content-id-index'
import type { EntryLinkUrlResolver } from '../../entry-link-resolver'
import { unsafeAsLogicalPath, unsafeAsSlug } from '../../paths/test-utils'
import { generateAIContent } from '../generate'
import { decideReferenceLinks } from '../references'
import type { AIContentConfig, AIEntry, AIReferenceLinkContext, AIReferenceLinkFn } from '../types'

const personRef = {
  name: 'author',
  type: 'reference' as const,
  label: 'Author',
  collections: ['people', 'drafts'],
}

const person = {
  name: 'person',
  label: 'Person',
  format: 'md' as const,
  default: true,
  schema: [{ name: 'fullName', type: 'string' as const, isTitle: true }],
}

const schema = {
  collections: [
    { name: 'people', path: 'people', entries: [person] },
    { name: 'drafts', path: 'drafts', entries: [person] },
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'md' as const,
          default: true,
          schema: [
            { name: 'title', type: 'string' as const },
            personRef,
            { ...personRef, name: 'reviewers', label: 'Reviewers', list: true },
          ],
        },
      ],
    },
  ],
} as const

/** The adopter's rule: a person has a page only when their bio has prose. */
const bioPredicate: AIReferenceLinkFn = (_target, { body }) => (body?.trim() ? undefined : false)

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-ai-reflink-'))

async function idOf(store: ContentStore, collection: string, slug: string): Promise<string> {
  const listed = await store.getCollectionEntryPaths(unsafeAsLogicalPath(collection))
  const entry = listed.find((e) => e.slug === slug)
  if (!entry) throw new Error(`entry not found: ${collection}/${slug}`)
  return extractIdFromFilename(path.basename(entry.relativePath)) as string
}

describe('generateAIContent: referenceLink', () => {
  let root: string
  let flat: ReturnType<typeof flattenSchema>
  let store: ContentStore
  let ids: { alice: string; bob: string; carol: string; draft: string }
  const missingId = 'zzzzzzzzzzzz'

  beforeEach(async () => {
    root = await tmpDir()
    const config = defineCanopyTestConfig({ schema })
    flat = flattenSchema(schema, config.contentRoot)
    store = new ContentStore(root, flat)
    const writePerson = (collection: string, slug: string, fullName: string, body: string) =>
      store.write(unsafeAsLogicalPath(collection), unsafeAsSlug(slug), {
        format: 'md',
        data: { fullName },
        body,
      })
    await writePerson('content/people', 'alice', 'Alice Example', 'Alice studies tides.')
    await writePerson('content/people', 'bob', 'Bob Example', '  \n')
    await writePerson('content/people', 'carol', 'Carol Example', 'Carol maps reefs.')
    await writePerson('content/drafts', 'draft', 'Draft Person', 'Not yet public.')
    ids = {
      alice: await idOf(store, 'content/people', 'alice'),
      bob: await idOf(store, 'content/people', 'bob'),
      carol: await idOf(store, 'content/people', 'carol'),
      draft: await idOf(store, 'content/drafts', 'draft'),
    }
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('first'), {
      format: 'md',
      data: {
        title: 'First',
        author: ids.alice,
        reviewers: [ids.bob, ids.draft, missingId, ids.alice],
      },
      body: [
        `See [Bob](entry:${ids.bob}) and [Alice](entry:${ids.alice}#bio).`,
        `Raw: <a href="entry:${ids.bob}">Bob</a>.`,
        `Also [Carol](entry:${ids.carol}).`,
      ].join('\n'),
    })
    // A fresh store, so nothing the setup wrote is cached
    store = new ContentStore(root, flat)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  const generate = (config?: AIContentConfig, entryLinkUrl?: EntryLinkUrlResolver) =>
    generateAIContent({
      store,
      flatSchema: flat,
      contentRoot: 'content',
      config: { exclude: { collections: ['drafts'] }, ...config },
      entryLinkUrl,
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
  const post = async (config?: AIContentConfig) =>
    (await generate(config)).files.get('posts/first.md') ?? ''

  it('changes nothing when the callback returns undefined for every target', async () => {
    const plain = await generate()
    const deferred = await generate({ referenceLink: () => undefined })
    expect([...deferred.files]).toEqual([...plain.files])
    expect(plain.files.get('posts/first.md')).toContain(
      '**Author:** [Alice Example](/people/alice) ([markdown version](/ai/people/alice.md))',
    )
  })

  it('links a returned URL from references and body entry: links alike, keeping the copy', async () => {
    const md = await post({ referenceLink: (target) => `/team/${String(target.slug)}` })
    expect(md).toContain(
      '**Author:** [Alice Example](/team/alice) ([markdown version](/ai/people/alice.md))',
    )
    expect(md).toContain('See [Bob](/team/bob) and [Alice](/team/alice#bio).')
    expect(md).toContain('<a href="/team/bob">Bob</a>')
    expect(md).not.toContain('](/people/')
  })

  it('renders a target judged by its body as plain text, with no page or copy link', async () => {
    const md = await post({ referenceLink: bioPredicate })
    expect(md).toContain(
      `**Reviewers:** Bob Example, (unavailable entry ${ids.draft}), (missing entry ${missingId}), [Alice Example](/people/alice) ([markdown version](/ai/people/alice.md))`,
    )
    expect(md).not.toContain('/people/bob')
    expect(md).toContain('See Bob and [Alice](/people/alice#bio).')
    expect(md).toContain('<a href="#">Bob</a>')
  })

  it('awaits an async callback', async () => {
    const md = await post({
      referenceLink: async (target, ctx) => bioPredicate(target, ctx),
    })
    expect(md).toContain('**Reviewers:** Bob Example, ')
    expect(md).toContain('**Author:** [Alice Example](/people/alice)')
  })

  it('asks once per exported target, with its stored body and default URL, never a masked one', async () => {
    const calls: Array<{ id: unknown; context: AIReferenceLinkContext }> = []
    await generate(
      {
        referenceLink: (target, context) => {
          calls.push({ id: target.id, context })
          return undefined
        },
      },
      () => '/custom',
    )
    expect(calls.map((call) => call.id).sort()).toEqual([ids.alice, ids.bob, ids.carol].sort())
    const alice = calls.find((call) => call.id === ids.alice)?.context
    expect(alice?.body?.trim()).toBe('Alice studies tides.')
    expect(alice?.defaultUrl).toBe('/custom')
  })

  it('offers each target as the store resolves it, built from the export read, not a re-read', async () => {
    const asResolved = await new ContentStore(root, flat).resolveReferenceTarget(ids.carol)
    const resolve = vi.spyOn(ContentStore.prototype, 'resolveReferenceTarget')
    const seen = new Map<unknown, unknown>()
    await generate({
      referenceLink: (target) => {
        seen.set(target.id, target)
        return undefined
      },
    })
    // Carol is linked only from a body, so nothing but the hook would read her as a target
    expect(seen.get(ids.carol)).toEqual(asResolved)
    expect(resolve.mock.calls.map((call) => call[0])).not.toContain(ids.carol)
  })

  it('leaves a target whose entryLinkUrl throws to fail as it does without the hook', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('second'), {
      format: 'md',
      data: { title: 'Second', author: ids.alice },
      body: 'No links.',
    })
    store = new ContentStore(root, flat)
    const entryLinkUrl: EntryLinkUrlResolver = ({ id, slug }) => {
      if (id === ids.alice) throw new Error('no route')
      return `/people/${slug}`
    }
    const referenceLink = vi.fn<AIReferenceLinkFn>(() => '/override')
    const withHook = await generate({ referenceLink }, entryLinkUrl)
    const without = await generate(undefined, entryLinkUrl)
    expect(referenceLink.mock.calls.map(([target]) => target.id)).not.toContain(ids.alice)
    expect([...withHook.files.keys()].sort()).toEqual([...without.files.keys()].sort())
    expect(withHook.files.has('posts/second.md')).toBe(false)
  })

  it('encodes a returned URL the same way in references and body links', async () => {
    const md = await post({
      referenceLink: (target) => `/team/${String(target.slug)} (b)'"<>\t\\z`,
    })
    const encoded = (slug: string) => `/team/${slug}%20%28b%29%27%22%3C%3E%09%5Cz`
    expect(md).toContain(`**Author:** [Alice Example](${encoded('alice')}) (`)
    expect(md).toContain(`[Alice](${encoded('alice')}#bio)`)
    expect(md).toContain(`<a href="${encoded('bob')}">Bob</a>`)
  })

  it('never links a target whose own render fails, whatever the callback returns', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const md = await post({
      referenceLink: (target) => `/team/${String(target.slug)}`,
      fieldTransforms: {
        person: {
          fullName: (value) => {
            if (value === 'Alice Example') throw new Error('render failed')
            return String(value)
          },
        },
      },
    })
    expect(md).toContain(`**Author:** (unavailable entry ${ids.alice})`)
    expect(md).toContain('and Alice.')
    expect(md).not.toContain('/team/alice')
  })

  it('refuses a referenceLink that is not a function', async () => {
    const referenceLink = true as unknown as AIReferenceLinkFn
    await expect(generate({ referenceLink })).rejects.toThrow('referenceLink must be a function')
  })

  describe('a broken callback', () => {
    let warn: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    const broken: Array<[string, AIReferenceLinkFn]> = [
      [
        'throws',
        () => {
          throw new Error('boom')
        },
      ],
      ['returns an empty string', () => ' '],
      ['returns a non-string', () => 42 as unknown as string],
    ]
    it.each(broken)('withholds the link and warns when it %s', async (_label, referenceLink) => {
      const md = await post({ referenceLink })
      expect(md).toContain('**Author:** Alice Example\n')
      expect(md).toContain('See Bob and Alice.')
      expect(md).toContain('Also Carol.')
      expect(warn.mock.calls.some((call: unknown[]) => String(call[0]).includes(ids.alice))).toBe(
        true,
      )
    })
  })
})

describe('decideReferenceLinks', () => {
  const field = { name: 'author', type: 'reference' as const, label: 'Author' }
  const entryWith = (author: unknown, body?: string) => ({
    entry: {
      slug: 'post',
      collection: 'posts',
      collectionName: 'posts',
      entryType: 'post',
      format: 'json',
      data: { author },
      fields: [field],
    } satisfies AIEntry,
    body,
  })
  const subject = (id: string, urlPath: string) => ({
    target: { id, slug: 's', collection: 'content/people', urlPath },
    body: undefined,
  })

  it('never asks about an id the export does not hold, however it is linked', async () => {
    const referenceLink = vi.fn(() => undefined)
    const held = subject('heldTargetAB', '/people/s')
    const lookup = await decideReferenceLinks(
      referenceLink,
      [entryWith({ ...held.target }, '[Gone](entry:missingXYZAB)')],
      (id) => (id === held.target.id ? held : undefined),
      undefined,
    )
    expect(
      referenceLink.mock.calls.map((call: unknown[]) => (call[0] as { id: string }).id),
    ).toEqual(['heldTargetAB'])
    expect(lookup('missingXYZAB')).toBeUndefined()
  })

  it('still asks about a target with no default URL, so a site can supply one', async () => {
    const held = subject('noUrlTargetA', '')
    const lookup = await decideReferenceLinks(
      (_target, { defaultUrl }) => (defaultUrl === undefined ? '/supplied' : undefined),
      [entryWith({ ...held.target })],
      () => held,
      undefined,
    )
    expect(lookup('noUrlTargetA')).toBe('/supplied')
  })
})

describe('generateAIContent: referenceLink for a yaml target with an isBody field', () => {
  const yamlSchema = {
    collections: [
      {
        name: 'people',
        path: 'people',
        entries: [
          {
            name: 'person',
            format: 'yaml' as const,
            default: true,
            schema: [
              { name: 'fullName', type: 'string' as const, isTitle: true },
              { name: 'bio', type: 'mdx' as const, isBody: true },
            ],
          },
        ],
      },
      {
        name: 'posts',
        path: 'posts',
        entries: [
          {
            name: 'post',
            format: 'md' as const,
            default: true,
            schema: [{ name: 'title', type: 'string' as const }, personRef],
          },
        ],
      },
    ],
  } as const
  let root: string

  beforeEach(async () => {
    root = await tmpDir()
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('offers the target without the field, as the store resolves it, and the field as its body', async () => {
    const flat = flattenSchema(
      yamlSchema,
      defineCanopyTestConfig({ schema: yamlSchema }).contentRoot,
    )
    const store = new ContentStore(root, flat)
    await store.write(unsafeAsLogicalPath('content/people'), unsafeAsSlug('dana'), {
      format: 'yaml',
      data: { fullName: 'Dana Example', bio: 'Dana charts currents.' },
    })
    const dana = await idOf(store, 'content/people', 'dana')
    await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('first'), {
      format: 'md',
      data: { title: 'First', author: dana },
      body: '',
    })
    const asResolved = await store.resolveReferenceTarget(dana)

    const calls: Array<{ target: unknown; context: AIReferenceLinkContext }> = []
    await generateAIContent({
      store: new ContentStore(root, flat),
      flatSchema: flat,
      contentRoot: 'content',
      config: {
        referenceLink: (target, context) => {
          calls.push({ target, context })
          return undefined
        },
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].target).toEqual(asResolved)
    expect(calls[0].target).not.toHaveProperty('bio')
    expect(calls[0].context.body).toBe('Dana charts currents.')
  })
})
