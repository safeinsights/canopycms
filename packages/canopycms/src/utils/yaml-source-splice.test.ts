import { describe, expect, it } from 'vitest'
import { parseDocument, Scalar, type Document, type YAMLMap } from 'yaml'

import { snapshotDocument, spliceSource } from './yaml-source-splice'

const RAW = `title: Hello
body: >-
  folded by hand
  at a narrow width
`

describe('spliceSource', () => {
  it('discards a splice that does not reproduce the reconciled document', () => {
    const doc: Document = parseDocument(RAW)
    const map = doc.contents as YAMLMap<unknown, unknown>
    map.items[0].value = new Scalar('Edited')
    // A snapshot taken AFTER the change cannot see it, so the splice copies the stale source.
    const snapshot = snapshotDocument(doc)
    expect(spliceSource(RAW, doc, snapshot, new WeakMap(), doc.toString())).toBeUndefined()
  })

  it('returns the splice when it does reproduce the reconciled document', () => {
    const doc: Document = parseDocument(RAW)
    const snapshot = snapshotDocument(doc)
    const map = doc.contents as YAMLMap<unknown, unknown>
    map.items[0].value = new Scalar('Edited')
    expect(spliceSource(RAW, doc, snapshot, new WeakMap(), doc.toString())).toBe(
      RAW.replace('title: Hello', 'title: Edited'),
    )
  })
})
