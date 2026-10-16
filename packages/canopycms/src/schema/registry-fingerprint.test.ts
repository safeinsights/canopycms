import { describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import { registryFingerprint } from './registry-fingerprint'
import type { EntrySchemaRegistry } from './types'

const field = (extra: Record<string, unknown>): FieldConfig =>
  ({ name: 'title', type: 'string', ...extra }) as FieldConfig

const registryOf = (fields: Record<string, unknown>[]): EntrySchemaRegistry => ({
  pageSchema: fields.map(field),
})

describe('registryFingerprint', () => {
  it('is a fixed digest of the content, the same in every process', () => {
    expect(registryFingerprint(registryOf([{ label: 'Title' }]))).toBe(
      '22e0dbe3482ee4c327730920e65e3536ef686210f3e790cc7000438feffe51f9',
    )
  })

  it('ignores key order, so declaration order cannot change it', () => {
    const a: EntrySchemaRegistry = {
      pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      postSchema: [{ name: 'body', type: 'markdown' }],
    }
    const b = {
      postSchema: [{ type: 'markdown', name: 'body' }],
      pageSchema: [{ label: 'Title', type: 'string', name: 'title' }],
    } as EntrySchemaRegistry

    expect(registryFingerprint(b)).toBe(registryFingerprint(a))
  })

  it('differs when any field definition differs', () => {
    const base = registryFingerprint(registryOf([{ label: 'Title' }]))

    expect(registryFingerprint(registryOf([{ label: 'Heading' }]))).not.toBe(base)
    expect(registryFingerprint(registryOf([{ label: 'Title' }, { name: 'more' }]))).not.toBe(base)
    expect(
      registryFingerprint({ otherSchema: registryOf([{ label: 'Title' }]).pageSchema }),
    ).not.toBe(base)
  })

  it('keeps array order, which is field order', () => {
    const a = registryOf([{ name: 'a' }, { name: 'b' }])
    const b = registryOf([{ name: 'b' }, { name: 'a' }])

    expect(registryFingerprint(a)).not.toBe(registryFingerprint(b))
  })

  it('does not confuse values of different types or splits of one string', () => {
    const digests = [
      registryOf([{ extra: '1' }]),
      registryOf([{ extra: 1 }]),
      registryOf([{ extra: true }]),
      registryOf([{ extra: 'true' }]),
      registryOf([{ extra: null }]),
      registryOf([{ extra: undefined }]),
      registryOf([{}]),
      registryOf([{ extra: ['a', 'b'] }]),
      registryOf([{ extra: ['ab'] }]),
      registryOf([{ extra: ['a', 'sb'] }]),
      registryOf([{ extra: ['as', 'b'] }]),
      registryOf([{ extra: { a: 'b' } }]),
      registryOf([{ ex: 'tra' }]),
    ].map(registryFingerprint)

    expect(new Set(digests).size).toBe(digests.length)
  })

  it('counts a function by its source, where JSON would drop it', () => {
    const a = registryOf([{ format: (value: string) => value.trim() }])
    const sameSource = registryOf([{ format: (value: string) => value.trim() }])
    const otherSource = registryOf([{ format: (value: string) => value.toUpperCase() }])
    const none = registryOf([{}])

    expect(registryFingerprint(sameSource)).toBe(registryFingerprint(a))
    expect(registryFingerprint(otherSource)).not.toBe(registryFingerprint(a))
    expect(registryFingerprint(none)).not.toBe(registryFingerprint(a))
  })

  it('terminates on a cycle, deterministically', () => {
    const cyclic = (): EntrySchemaRegistry => {
      const self: Record<string, unknown> = { name: 'self', type: 'custom' }
      self.loop = self
      return { pageSchema: [self as unknown as FieldConfig] }
    }

    expect(registryFingerprint(cyclic())).toBe(registryFingerprint(cyclic()))
  })

  it('does not mistake a shared object for a cycle', () => {
    const shared = [{ name: 'title', type: 'string' }] as FieldConfig[]
    const twice: EntrySchemaRegistry = { a: shared, b: shared }
    const copies: EntrySchemaRegistry = {
      a: [{ name: 'title', type: 'string' }],
      b: [{ name: 'title', type: 'string' }],
    }

    expect(registryFingerprint(twice)).toBe(registryFingerprint(copies))
  })
})
