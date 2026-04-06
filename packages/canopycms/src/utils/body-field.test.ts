import { describe, it, expect } from 'vitest'
import { findBodyFieldName, countBodyFields, findInvalidBodyFields } from './body-field'
import type { FieldConfig } from '../config'

describe('findBodyFieldName', () => {
  it('returns the name of the field marked isBody', () => {
    const fields: FieldConfig[] = [
      { name: 'title', type: 'string' },
      { name: 'content', type: 'markdown', isBody: true },
    ]
    expect(findBodyFieldName(fields)).toBe('content')
  })

  it('defaults to "body" when no field has isBody', () => {
    const fields: FieldConfig[] = [
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
    ]
    expect(findBodyFieldName(fields)).toBe('body')
  })

  it('defaults to "body" for empty fields array', () => {
    expect(findBodyFieldName([])).toBe('body')
  })
})

describe('countBodyFields', () => {
  it('returns 0 when no fields have isBody', () => {
    const fields: FieldConfig[] = [{ name: 'title', type: 'string' }]
    expect(countBodyFields(fields)).toBe(0)
  })

  it('counts fields with isBody: true', () => {
    const fields: FieldConfig[] = [
      { name: 'body', type: 'markdown', isBody: true },
      { name: 'content', type: 'mdx', isBody: true },
    ]
    expect(countBodyFields(fields)).toBe(2)
  })
})

describe('findInvalidBodyFields', () => {
  it('returns empty array when all isBody fields have valid types', () => {
    const fields: FieldConfig[] = [{ name: 'body', type: 'markdown', isBody: true }]
    expect(findInvalidBodyFields(fields)).toEqual([])
  })

  it('returns field names with invalid types for isBody', () => {
    const fields: FieldConfig[] = [{ name: 'body', type: 'string', isBody: true }]
    expect(findInvalidBodyFields(fields)).toEqual(['body'])
  })
})
