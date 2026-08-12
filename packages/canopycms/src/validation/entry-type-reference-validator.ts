/**
 * Validates that every reference field's `entryTypes` names an entry type that
 * actually exists in the resolved schema.
 *
 * Without this, a typo (`entryTypes: ['parter']` for `'partner'`) is accepted
 * silently and surfaces much later as a reference picker that returns zero
 * results, with nothing pointing at the cause.
 *
 * This runs after schema resolution rather than at config-validation time on
 * purpose: entry types are declared per-collection in `.collection.json` files
 * on disk, so the set of valid names only exists once a branch's schema has
 * been resolved. `config/validation.ts`'s `ensureReferenceFieldsHaveScope` runs
 * at entry-schema *registration* (entry-schema-registry.ts), before any branch
 * schema exists, and so cannot perform this check.
 */

import type { CollectionConfig, EntryTypeConfig, RootCollectionConfig } from '../config'
import { forEachReferenceField } from '../config/validation'

/**
 * Levenshtein edit distance, bounded use only (short identifier strings).
 * Kept local and tiny rather than pulling in a runtime dependency purely to
 * produce a "did you mean" hint in an error message.
 */
const editDistance = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = curr
  }
  return prev[b.length]
}

/** Closest known name within a small edit distance, if there is one. */
const closestName = (name: string, known: readonly string[]): string | undefined => {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  // Allow a little more slack for longer names, but never suggest something
  // that shares almost nothing with what was written.
  const threshold = Math.max(2, Math.floor(name.length / 3))
  return best !== undefined && bestDistance <= threshold ? best : undefined
}

/** Walk the collection tree, visiting every entry type with its collection path. */
const forEachEntryType = (
  schema: RootCollectionConfig,
  visit: (entryType: EntryTypeConfig, collectionPath: string) => void,
): void => {
  const walk = (node: RootCollectionConfig | CollectionConfig, nodePath: string): void => {
    for (const entryType of node.entries ?? []) {
      visit(entryType, nodePath)
    }
    for (const child of node.collections ?? []) {
      walk(child, child.path ?? (nodePath ? `${nodePath}/${child.name}` : child.name))
    }
  }
  walk(schema, '')
}

/**
 * Collect every entry type name defined anywhere in the schema.
 *
 * Entry types are scoped per collection, and the same name may legitimately
 * appear in several collections, so this is a flat set of names: a reference
 * field's `entryTypes` is matched against entries across all collections
 * (see reference-resolver.ts, which filters resolved entries by entry type name
 * without regard to which collection defined it).
 */
export const collectEntryTypeNames = (schema: RootCollectionConfig): Set<string> => {
  const names = new Set<string>()
  forEachEntryType(schema, (entryType) => {
    if (typeof entryType.name === 'string' && entryType.name.length > 0) {
      names.add(entryType.name)
    }
  })
  return names
}

/**
 * Check every reference field's `entryTypes` against the schema's entry types.
 *
 * @returns One human-readable message per offending value; empty when valid.
 */
export const validateReferenceEntryTypes = (schema: RootCollectionConfig): string[] => {
  const known = collectEntryTypeNames(schema)
  const knownList = [...known].sort()
  const issues: string[] = []

  forEachEntryType(schema, (entryType, collectionPath) => {
    const location = collectionPath ? `${collectionPath}/${entryType.name}` : entryType.name

    forEachReferenceField(entryType.schema, (field) => {
      const entryTypes = field.entryTypes
      if (!Array.isArray(entryTypes)) return

      const fieldName = typeof field.name === 'string' ? field.name : 'unknown'
      for (const value of entryTypes) {
        if (typeof value !== 'string' || known.has(value)) continue

        const suggestion = closestName(value, knownList)
        issues.push(
          `Reference field "${fieldName}" in "${location}" specifies entryType ` +
            `"${value}", which is not defined in any collection.` +
            (suggestion ? ` Did you mean "${suggestion}"?` : '') +
            (knownList.length > 0
              ? ` Known entry types: ${knownList.join(', ')}.`
              : ' No entry types are defined in this schema.'),
        )
      }
    })
  })

  return issues
}
