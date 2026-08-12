import { describe, expect, it } from 'vitest'

import type { RootCollectionConfig } from '../../config'
import {
  collectEntryTypeNames,
  validateReferenceEntryTypes,
} from '../entry-type-reference-validator'

/** Minimal schema builder — only the fields the validator actually reads. */
const schemaWith = (referenceEntryTypes: string[]): RootCollectionConfig =>
  ({
    collections: [
      {
        name: 'posts',
        path: 'posts',
        entries: [
          {
            name: 'post',
            format: 'json',
            schema: [
              { name: 'title', type: 'string' },
              { name: 'related', type: 'reference', entryTypes: referenceEntryTypes },
            ],
          },
        ],
      },
      {
        name: 'people',
        path: 'people',
        entries: [{ name: 'partner', format: 'json', schema: [{ name: 'name', type: 'string' }] }],
      },
    ],
  }) as unknown as RootCollectionConfig

describe('collectEntryTypeNames', () => {
  it('collects entry type names from every collection in the tree', () => {
    expect(collectEntryTypeNames(schemaWith(['partner']))).toEqual(new Set(['post', 'partner']))
  })

  it('includes root-level entries and nested collections', () => {
    const schema = {
      entries: [{ name: 'settings', format: 'json', schema: [] }],
      collections: [
        {
          name: 'docs',
          path: 'docs',
          entries: [{ name: 'doc', format: 'json', schema: [] }],
          collections: [
            {
              name: 'api',
              path: 'docs/api',
              entries: [{ name: 'endpoint', format: 'json', schema: [] }],
            },
          ],
        },
      ],
    } as unknown as RootCollectionConfig

    expect(collectEntryTypeNames(schema)).toEqual(new Set(['settings', 'doc', 'endpoint']))
  })
})

describe('validateReferenceEntryTypes', () => {
  it('accepts an entryType defined in another collection', () => {
    // Entry types are declared per collection, but a reference field is matched
    // against entries across all of them (see reference-resolver.ts).
    expect(validateReferenceEntryTypes(schemaWith(['partner']))).toEqual([])
  })

  it('reports an entryType that exists nowhere in the schema', () => {
    const issues = validateReferenceEntryTypes(schemaWith(['parter']))

    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('Reference field "related"')
    expect(issues[0]).toContain('"parter"')
    expect(issues[0]).toContain('not defined in any collection')
  })

  it('suggests the closest known name for a typo', () => {
    expect(validateReferenceEntryTypes(schemaWith(['parter']))[0]).toContain(
      'Did you mean "partner"?',
    )
  })

  it('lists the known entry types so the error is actionable without a suggestion', () => {
    expect(validateReferenceEntryTypes(schemaWith(['something-entirely-different']))[0]).toContain(
      'Known entry types: partner, post.',
    )
  })

  it('reports every offending value, not just the first', () => {
    expect(validateReferenceEntryTypes(schemaWith(['nope1', 'partner', 'nope2']))).toHaveLength(2)
  })

  it('reaches reference fields nested in groups, objects and block templates', () => {
    const nested = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'json',
              schema: [
                {
                  name: 'meta',
                  type: 'group',
                  fields: [{ name: 'inGroup', type: 'reference', entryTypes: ['ghost'] }],
                },
                {
                  name: 'details',
                  type: 'object',
                  fields: [{ name: 'inObject', type: 'reference', entryTypes: ['ghost'] }],
                },
                {
                  name: 'body',
                  type: 'block',
                  templates: [
                    {
                      name: 'callout',
                      fields: [{ name: 'inBlock', type: 'reference', entryTypes: ['ghost'] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as RootCollectionConfig

    const issues = validateReferenceEntryTypes(nested)
    expect(issues).toHaveLength(3)
    expect(issues.join('\n')).toContain('inGroup')
    expect(issues.join('\n')).toContain('inObject')
    expect(issues.join('\n')).toContain('inBlock')
  })

  it('ignores reference fields scoped only by collections', () => {
    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'json',
              schema: [{ name: 'related', type: 'reference', collections: ['posts'] }],
            },
          ],
        },
      ],
    } as unknown as RootCollectionConfig

    expect(validateReferenceEntryTypes(schema)).toEqual([])
  })
})
