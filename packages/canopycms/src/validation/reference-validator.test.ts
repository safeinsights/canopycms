import { describe, expect, it, beforeEach } from 'vitest'

import { ContentIdIndex } from '../content-id-index'
import type { ReferenceFieldConfig, FieldConfig } from '../config'
import { ReferenceValidator } from './reference-validator'
import { unsafeAsLogicalPath, unsafeAsPhysicalPath, unsafeAsSlug } from '../paths/test-utils'

describe('ReferenceValidator entryTypes', () => {
  let idIndex: ContentIdIndex
  const partnerId = 'p1r2t3n4a5b6'
  const docId = 'd1c2a3e4n5t6'

  beforeEach(() => {
    idIndex = new ContentIdIndex('/tmp/test')

    // Add a partner entry
    idIndex.add({
      type: 'entry',
      relativePath: unsafeAsPhysicalPath(
        `content/data-catalog/partner-a/partner.index.${partnerId}.json`,
      ),
      collection: unsafeAsLogicalPath('content/data-catalog/partner-a'),
      slug: unsafeAsSlug('index'),
    })

    // Add a doc entry in the same subcollection
    idIndex.add({
      type: 'entry',
      relativePath: unsafeAsPhysicalPath(
        `content/data-catalog/partner-a/doc.getting-started.${docId}.json`,
      ),
      collection: unsafeAsLogicalPath('content/data-catalog/partner-a'),
      slug: unsafeAsSlug('getting-started'),
    })
  })

  it('validates entry type when entryTypes is specified', async () => {
    const schema: FieldConfig[] = [
      {
        name: 'partner',
        type: 'reference',
        label: 'Partner',
        entryTypes: ['partner'],
      } as ReferenceFieldConfig,
    ]

    const validator = new ReferenceValidator(idIndex, schema)

    // Partner entry should pass
    const validResult = await validator.validate({ partner: partnerId })
    expect(validResult.valid).toBe(true)

    // Doc entry should fail
    const invalidResult = await validator.validate({ partner: docId })
    expect(invalidResult.valid).toBe(false)
    expect(invalidResult.errors[0].error).toContain('Entry has type "doc"')
    expect(invalidResult.errors[0].error).toContain('only [partner] are allowed')
  })

  it('validates both collections and entryTypes together', async () => {
    const schema: FieldConfig[] = [
      {
        name: 'partner',
        type: 'reference',
        label: 'Partner',
        collections: ['content/data-catalog'],
        entryTypes: ['partner'],
      } as ReferenceFieldConfig,
    ]

    const validator = new ReferenceValidator(idIndex, schema)

    // Partner in data-catalog tree should pass
    const validResult = await validator.validate({ partner: partnerId })
    expect(validResult.valid).toBe(true)

    // Doc in data-catalog tree should fail (wrong entry type)
    const invalidResult = await validator.validate({ partner: docId })
    expect(invalidResult.valid).toBe(false)
    expect(invalidResult.errors[0].error).toContain('Entry has type "doc"')
  })

  it('allows any entry type when entryTypes is not specified', async () => {
    const schema: FieldConfig[] = [
      {
        name: 'ref',
        type: 'reference',
        label: 'Reference',
        collections: ['content/data-catalog'],
      } as ReferenceFieldConfig,
    ]

    const validator = new ReferenceValidator(idIndex, schema)

    // Both partner and doc should pass
    const partnerResult = await validator.validate({ ref: partnerId })
    expect(partnerResult.valid).toBe(true)

    const docResult = await validator.validate({ ref: docId })
    expect(docResult.valid).toBe(true)
  })

  it('validates entry type with entryTypes only (no collections)', async () => {
    const schema: FieldConfig[] = [
      {
        name: 'partner',
        type: 'reference',
        label: 'Partner',
        entryTypes: ['partner'],
      } as ReferenceFieldConfig,
    ]

    const validator = new ReferenceValidator(idIndex, schema)

    const validResult = await validator.validate({ partner: partnerId })
    expect(validResult.valid).toBe(true)

    const invalidResult = await validator.validate({ partner: docId })
    expect(invalidResult.valid).toBe(false)
  })

  describe('validateSingle', () => {
    it('rejects entry with wrong type', async () => {
      const field: ReferenceFieldConfig = {
        name: 'partner',
        type: 'reference',
        label: 'Partner',
        entryTypes: ['partner'],
      }

      const validator = new ReferenceValidator(idIndex, [])

      const error = await validator.validateSingle(docId, field)
      expect(error).not.toBeNull()
      expect(error!.error).toContain('Entry has type "doc"')
    })

    it('accepts entry with correct type', async () => {
      const field: ReferenceFieldConfig = {
        name: 'partner',
        type: 'reference',
        label: 'Partner',
        entryTypes: ['partner'],
      }

      const validator = new ReferenceValidator(idIndex, [])

      const error = await validator.validateSingle(partnerId, field)
      expect(error).toBeNull()
    })

    it('rejects entry failing both collection and entryType', async () => {
      // Add an entry in a different collection
      const otherId = 'x7y8z9abB1c2'
      idIndex.add({
        type: 'entry',
        relativePath: unsafeAsPhysicalPath(`content/blog/post.hello.${otherId}.json`),
        collection: unsafeAsLogicalPath('content/blog'),
        slug: unsafeAsSlug('hello'),
      })

      const field: ReferenceFieldConfig = {
        name: 'partner',
        type: 'reference',
        label: 'Partner',
        collections: ['content/data-catalog'],
        entryTypes: ['partner'],
      }

      const validator = new ReferenceValidator(idIndex, [])

      // Should fail on collection constraint (not in data-catalog tree)
      const error = await validator.validateSingle(otherId, field)
      expect(error).not.toBeNull()
      expect(error!.error).toContain('content/blog')
    })
  })
})

describe('ReferenceValidator block-nested references (SCH-H-block)', () => {
  // Real block data is { template, value } (see editor BlockField.tsx). The
  // traversal previously keyed off `_type`, so reference IDs inside blocks
  // were never validated on save — bad IDs passed silently (COMPOUND-2).
  let idIndex: ContentIdIndex
  const pageId = 'g1h2j3k4m5n6'

  const schema: FieldConfig[] = [
    {
      name: 'sections',
      type: 'block',
      label: 'Sections',
      templates: [
        {
          name: 'callout',
          label: 'Callout',
          fields: [
            {
              name: 'link',
              type: 'reference',
              label: 'Link',
              collections: ['content/pages'],
            } as ReferenceFieldConfig,
          ],
        },
      ],
    } as FieldConfig,
  ]

  beforeEach(() => {
    idIndex = new ContentIdIndex('/tmp/test')
    idIndex.add({
      type: 'entry',
      relativePath: unsafeAsPhysicalPath(`content/pages/page.about.${pageId}.json`),
      collection: unsafeAsLogicalPath('content/pages'),
      slug: unsafeAsSlug('about'),
    })
  })

  it('rejects a non-existent reference ID inside a block', async () => {
    const validator = new ReferenceValidator(idIndex, schema)

    const result = await validator.validate({
      sections: [{ template: 'callout', value: { link: 'z9z9z9z9z9z9' } }],
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].fieldPath).toBe('sections[0].link')
    expect(result.errors[0].error).toBe('Referenced entry does not exist')
  })

  it('rejects a malformed reference ID inside a block', async () => {
    const validator = new ReferenceValidator(idIndex, schema)

    const result = await validator.validate({
      sections: [{ template: 'callout', value: { link: 'not-an-id' } }],
    })

    expect(result.valid).toBe(false)
    expect(result.errors[0].fieldPath).toBe('sections[0].link')
    expect(result.errors[0].error).toBe('Invalid content ID format')
  })

  it('accepts a valid reference ID inside a block', async () => {
    const validator = new ReferenceValidator(idIndex, schema)

    const result = await validator.validate({
      sections: [{ template: 'callout', value: { link: pageId } }],
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})
