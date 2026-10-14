import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from '../../config-test'
import { flattenSchema } from '../../config'
import { ContentStore } from '../../content-store'
import { extractIdFromFilename } from '../../content-id-index'
import { buildRestrictedReference } from '../../entry-schema'
import { unsafeAsLogicalPath, unsafeAsSlug } from '../../paths/test-utils'
import { generateAIContent } from '../generate'
import { decideReferenceLinks } from '../references'
import type {
  AIContentConfig,
  AIEntry,
  AIReferenceLinkContext,
  AIReferenceLinkFn,
  AIReferenceValue,
} from '../types'

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

  const generate = (config?: AIContentConfig, entryLinkUrl?: () => string) =>
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

  it('resolves every target without an ACL, so no restricted reference can reach it', async () => {
    const resolve = vi.spyOn(ContentStore.prototype, 'resolveReferenceTarget')
    await generate({ referenceLink: () => undefined })
    // Carol is linked only from a body, so only the referenceLink pre-pass resolves her
    expect(resolve.mock.calls.map((call) => call[0])).toContain(ids.carol)
    for (const call of resolve.mock.calls) expect(call[1]).toBeUndefined()
  })

  it('encodes a returned URL the same way in references and body links', async () => {
    const md = await post({ referenceLink: (target) => `/team/${String(target.slug)} (bio)` })
    expect(md).toContain('**Author:** [Alice Example](/team/alice%20%28bio%29) (')
    expect(md).toContain('[Alice](/team/alice%20%28bio%29#bio)')
    expect(md).toContain('<a href="/team/bob%20%28bio%29">Bob</a>')
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
  const entryWith = (author: unknown): AIEntry => ({
    slug: 'post',
    collection: 'posts',
    collectionName: 'posts',
    entryType: 'post',
    format: 'json',
    data: { author },
    fields: [field],
  })

  it('skips a restricted target even when its id is exported', async () => {
    // Not an AIReferenceValue: the AI export resolves without an ACL, so it never makes one
    const restricted = buildRestrictedReference(
      { id: 'restrictedAB', slug: 'r', collection: 'content/people', urlPath: '/people/r' },
      'Restricted',
    ) as unknown as AIReferenceValue
    const referenceLink = vi.fn(() => undefined)
    await decideReferenceLinks(
      referenceLink,
      // Reached through a body link, so only the check on the resolved value can skip it
      [{ entry: entryWith(''), body: '[R](entry:restrictedAB)' }],
      new Set(['restrictedAB']),
      async () => restricted,
      () => undefined,
      undefined,
    )
    expect(referenceLink).not.toHaveBeenCalled()
  })

  it('still asks about a target with no default URL, so a site can supply one', async () => {
    const target = { id: 'nourl0000001', slug: 'n', collection: 'content/people', urlPath: '' }
    const lookup = await decideReferenceLinks(
      (_target, { defaultUrl }) => (defaultUrl === undefined ? '/supplied' : undefined),
      [{ entry: entryWith(target) }],
      new Set(['nourl0000001']),
      async () => target,
      () => undefined,
      undefined,
    )
    expect(lookup('nourl0000001')).toBe('/supplied')
  })

  it('withholds the link to a target it cannot read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const referenceLink = vi.fn(() => undefined)
    const lookup = await decideReferenceLinks(
      referenceLink,
      [{ entry: entryWith(''), body: '[R](entry:cannotReadXY)' }],
      new Set(['cannotReadXY']),
      () => Promise.reject(new Error('transient')),
      () => undefined,
      undefined,
    )
    expect(lookup('cannotReadXY')).toBe(false)
    expect(referenceLink).not.toHaveBeenCalled()
    expect(
      warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('cannotReadXY')),
    ).toBe(true)
  })

  it('leaves a target undecided when entryLinkUrl throws, without blaming referenceLink', async () => {
    const target = { id: 'throws000001', slug: 't', collection: 'content/people', urlPath: '/t' }
    const referenceLink = vi.fn(() => false as const)
    const lookup = await decideReferenceLinks(
      referenceLink,
      [{ entry: entryWith(target) }],
      new Set(['throws000001']),
      async () => target,
      () => undefined,
      () => {
        throw new Error('entryLinkUrl failed')
      },
    )
    expect(referenceLink).not.toHaveBeenCalled()
    expect(lookup('throws000001')).toBeUndefined()
  })
})
