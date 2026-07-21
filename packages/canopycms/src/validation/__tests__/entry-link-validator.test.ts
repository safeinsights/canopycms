import { describe, it, expect, beforeEach } from 'vitest'

import { ContentIdIndex } from '../../content-id-index'
import type { FieldConfig } from '../../config'
import { validateEntryLinks } from '../entry-link-validator'
import { unsafeAsLogicalPath, unsafeAsPhysicalPath, unsafeAsSlug } from '../../paths/test-utils'

describe('validateEntryLinks', () => {
  let idIndex: ContentIdIndex
  const existingId = 'g1h2j3k4m5n6'
  const missingId = 'z9z9z9z9z9z9'

  beforeEach(() => {
    idIndex = new ContentIdIndex('/tmp/test')
    idIndex.add({
      type: 'entry',
      relativePath: unsafeAsPhysicalPath(`content/pages/page.about.${existingId}.json`),
      collection: unsafeAsLogicalPath('content/pages'),
      slug: unsafeAsSlug('about'),
    })
  })

  it('warns about a broken entry link in a top-level markdown field', () => {
    const schema: FieldConfig[] = [{ name: 'body', type: 'markdown', label: 'Body' }]
    const data = { body: `See [this page](entry:${missingId}) for details.` }

    const result = validateEntryLinks(data, schema, idIndex)

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].fieldPath).toBe('body')
    expect(result.warnings[0].id).toBe(missingId)
  })

  it('does not warn when the entry link target exists', () => {
    const schema: FieldConfig[] = [{ name: 'body', type: 'markdown', label: 'Body' }]
    const data = { body: `See [this page](entry:${existingId}).` }

    const result = validateEntryLinks(data, schema, idIndex)

    expect(result.warnings).toHaveLength(0)
  })

  describe('block-nested entry links (SCH-H-block)', () => {
    // Real block data is { template, value } (see editor BlockField.tsx). The
    // traversal previously keyed off `_type`, so markdown fields inside blocks
    // were never scanned and broken entry links got no orphan warnings.
    const schema: FieldConfig[] = [
      {
        name: 'sections',
        type: 'block',
        label: 'Sections',
        templates: [
          {
            name: 'prose',
            label: 'Prose',
            fields: [{ name: 'text', type: 'markdown', label: 'Text' }],
          },
        ],
      } as FieldConfig,
    ]

    it('warns about a broken entry link inside a block', () => {
      const data = {
        sections: [{ template: 'prose', value: { text: `Broken: entry:${missingId}` } }],
      }

      const result = validateEntryLinks(data, schema, idIndex)

      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0].fieldPath).toBe('sections[0].text')
      expect(result.warnings[0].id).toBe(missingId)
    })

    it('does not warn when the block-nested entry link target exists', () => {
      const data = {
        sections: [{ template: 'prose', value: { text: `Fine: entry:${existingId}` } }],
      }

      const result = validateEntryLinks(data, schema, idIndex)

      expect(result.warnings).toHaveLength(0)
    })
  })
})
