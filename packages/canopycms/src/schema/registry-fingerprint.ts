import { createHash } from 'node:crypto'

import type { EntrySchemaRegistry } from './types'

const fingerprints = new WeakMap<EntrySchemaRegistry, string>()

/**
 * A sha256 digest of an entry schema registry: equal for registries with equal content, so it
 * is stable across cold starts of one image, and different when any definition differs.
 *
 * Object keys are sorted, so declaration order cannot change it. Every value is tagged with
 * its type and every string carries its length, so distinct JSON-shaped values never write the
 * same bytes. A custom field may hold anything, so a function contributes its source text rather
 * than being dropped the way JSON drops it; any other object is walked by its own enumerable
 * keys (a Date, Map or Set writes like `{}`), and a value already on the walk's path is written
 * as a cycle marker rather than recursed into. Memoized per registry object, which the code
 * builds once.
 */
export function registryFingerprint(registry: EntrySchemaRegistry): string {
  const memo = fingerprints.get(registry)
  if (memo) return memo

  const hash = createHash('sha256')
  const ancestors = new Set<object>()
  const text = (tag: string, value: string) => hash.update(`${tag}${value.length}:${value}`)

  const write = (value: unknown): void => {
    switch (typeof value) {
      case 'string':
        return void text('s', value)
      case 'number':
      case 'bigint':
      case 'boolean':
        return void text(typeof value, String(value))
      case 'undefined':
        return void hash.update('u')
      case 'symbol':
        return void text('y', value.toString())
      case 'function':
        return void text('f', Function.prototype.toString.call(value))
    }
    if (value === null) return void hash.update('n')
    const object = value as object
    if (ancestors.has(object)) return void hash.update('c')
    ancestors.add(object)
    if (Array.isArray(object)) {
      hash.update(`[${object.length}`)
      for (const item of object) write(item)
    } else {
      const record = object as Record<string, unknown>
      const keys = Object.keys(record).sort()
      hash.update(`{${keys.length}`)
      for (const key of keys) {
        text('k', key)
        write(record[key])
      }
    }
    ancestors.delete(object)
  }

  write(registry)
  const digest = hash.digest('hex')
  fingerprints.set(registry, digest)
  return digest
}
