import { describe, expect, it } from 'vitest'
import { resolveEntryTitle as resolveEntryTitleFromServer } from '../server'
import { resolveEntryTitle as resolveEntryTitleFromRoot } from '../index'

/**
 * `resolveEntryTitle`'s own fallback-chain behavior is exhaustively covered by
 * title-field.test.ts. These tests exist to guard the actual bug this task
 * fixed: the function existed but no entrypoint re-exported it, so it was
 * unreachable from outside the package. A regression here (the re-export
 * line being dropped) should fail a test, not just go unnoticed until an
 * adopter's import breaks.
 */
describe('resolveEntryTitle entrypoint reachability', () => {
  it('is reachable from canopycms/server', () => {
    expect(resolveEntryTitleFromServer({ title: 'From server' })).toBe('From server')
  })

  it('is reachable from the root canopycms entry (client-safe re-export)', () => {
    expect(resolveEntryTitleFromRoot({ name: 'From root' })).toBe('From root')
  })

  it('both re-exports resolve to the same function', () => {
    expect(resolveEntryTitleFromServer).toBe(resolveEntryTitleFromRoot)
  })
})
