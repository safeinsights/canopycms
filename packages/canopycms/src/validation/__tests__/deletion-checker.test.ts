import { describe, it, expect } from 'vitest'
import { findReferencingEntries, type ReferenceScanEntry } from '../deletion-checker'
import type { FieldConfig } from '../../config'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'

const TARGET_ID = 'tgtTGTtgtTGT'

function entry(
  slug: string,
  schema: FieldConfig[] | undefined,
  data: Record<string, unknown>,
  options: { id?: string } = {},
): ReferenceScanEntry {
  return {
    entryPath: unsafeAsLogicalPath(`content/posts/${slug}`),
    entryId: unsafeAsContentId(options.id ?? `${slug}zzzzzzzzzzzz`.slice(0, 12)),
    schema,
    data,
  }
}

const authorSchema: FieldConfig[] = [
  { name: 'author', type: 'reference', label: 'Author', collections: ['people'] },
  { name: 'reviewers', type: 'reference', label: 'Reviewers', list: true, collections: ['people'] },
]

describe('findReferencingEntries', () => {
  it('reports each referencing entry once, with every position that holds the id', () => {
    const result = findReferencingEntries(
      [
        entry('a', authorSchema, { author: TARGET_ID, reviewers: [TARGET_ID, TARGET_ID] }),
        entry('b', authorSchema, { author: 'otherOTHER12' }),
      ],
      TARGET_ID,
    )
    expect(result).toHaveLength(1)
    expect(result[0].entry.entryPath).toBe('content/posts/a')
    expect(result[0].fields).toEqual(['author', 'reviewers[0]', 'reviewers[1]'])
    expect(result[0].links).toEqual([])
  })

  it('reads each entry by its own schema, so entry types sharing a collection are told apart', () => {
    const otherSchema: FieldConfig[] = [{ name: 'author', type: 'string', label: 'Author name' }]
    const result = findReferencingEntries(
      [
        entry('typed-a', authorSchema, { author: TARGET_ID }),
        entry('typed-b', otherSchema, { author: TARGET_ID }),
      ],
      TARGET_ID,
    )
    expect(result.map((r) => r.entry.entryPath)).toEqual(['content/posts/typed-a'])
  })

  it('finds references nested in objects, object lists and real { template, value } blocks', () => {
    const schema: FieldConfig[] = [
      {
        name: 'meta',
        type: 'object',
        label: 'Meta',
        fields: [{ name: 'reviewer', type: 'reference', label: 'R', collections: ['people'] }],
      },
      {
        name: 'credits',
        type: 'object',
        label: 'Credits',
        list: true,
        fields: [{ name: 'person', type: 'reference', label: 'P', collections: ['people'] }],
      },
      {
        name: 'blocks',
        type: 'block',
        label: 'Blocks',
        templates: [
          {
            name: 'hero',
            label: 'Hero',
            fields: [
              {
                name: 'cta',
                type: 'object',
                label: 'CTA',
                fields: [{ name: 'target', type: 'reference', label: 'T', collections: ['pages'] }],
              },
            ],
          },
        ],
      },
    ]
    const result = findReferencingEntries(
      [
        entry('nested', schema, {
          meta: { reviewer: TARGET_ID },
          credits: [{ person: 'otherOTHER12' }, { person: TARGET_ID }],
          blocks: [{ template: 'hero', value: { cta: { target: TARGET_ID } } }],
        }),
      ],
      TARGET_ID,
    )
    expect(result[0].fields).toEqual(['meta.reviewer', 'credits[1].person', 'blocks[0].cta.target'])
  })

  it('never reports the target as referencing itself', () => {
    const result = findReferencingEntries(
      [entry('self', authorSchema, { author: TARGET_ID }, { id: TARGET_ID })],
      TARGET_ID,
    )
    expect(result).toEqual([])
  })

  it('reads no reference fields from an entry with no resolvable schema, but still its links', () => {
    const result = findReferencingEntries(
      [entry('raw', undefined, { author: TARGET_ID, body: `[x](entry:${TARGET_ID})` })],
      TARGET_ID,
    )
    expect(result).toHaveLength(1)
    expect(result[0].fields).toEqual([])
    expect(result[0].links).toEqual(['body'])
  })

  describe('entry: links', () => {
    it('finds a link in a declared markdown field, and ignores one inside a code span', () => {
      const schema: FieldConfig[] = [
        { name: 'intro', type: 'markdown', label: 'Intro' },
        { name: 'notes', type: 'markdown', label: 'Notes' },
      ]
      const result = findReferencingEntries(
        [
          entry('linker', schema, {
            intro: `See [them](entry:${TARGET_ID}#bio).`,
            notes: `Code: \`entry:${TARGET_ID}\``,
          }),
        ],
        TARGET_ID,
      )
      expect(result[0].links).toEqual(['intro'])
      expect(result[0].fields).toEqual([])
    })

    it("finds a link in an md file's body when the schema does not declare a body field", () => {
      const schema: FieldConfig[] = [{ name: 'title', type: 'string', label: 'Title' }]
      const result = findReferencingEntries(
        [entry('page', schema, { title: 'T', body: `[x](entry:${TARGET_ID})` })],
        TARGET_ID,
      )
      expect(result[0].links).toEqual(['body'])
    })

    it('reports a declared isBody field once, under its own name', () => {
      const schema: FieldConfig[] = [
        { name: 'content', type: 'mdx', label: 'Content', isBody: true },
      ]
      const result = findReferencingEntries(
        [entry('page', schema, { content: `[x](entry:${TARGET_ID})` })],
        TARGET_ID,
      )
      expect(result[0].links).toEqual(['content'])
    })

    it('finds a link in any string the reader resolves, whatever its field type', () => {
      const schema: FieldConfig[] = [
        { name: 'ctaHref', type: 'string', label: 'CTA' },
        {
          name: 'blocks',
          type: 'block',
          label: 'Blocks',
          templates: [
            {
              name: 'card',
              label: 'Card',
              fields: [{ name: 'links', type: 'string', label: 'L' }],
            },
          ],
        },
      ]
      const result = findReferencingEntries(
        [
          entry('page', schema, {
            ctaHref: `entry:${TARGET_ID}`,
            blocks: [
              { template: 'card', value: { links: ['entry:otherOTHER12', `entry:${TARGET_ID}`] } },
            ],
          }),
        ],
        TARGET_ID,
      )
      expect(result[0].links).toEqual(['ctaHref', 'blocks[0].value.links[1]'])
    })
  })
})
