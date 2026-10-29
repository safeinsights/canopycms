import { describe, expect, it } from 'vitest'

import { branchShortName } from './branch-name'

describe('branchShortName', () => {
  it.each([
    ['canopycms/prod/spring', 'canopycms/prod/', 'spring'],
    // Outside the namespace, or with none resolved: the full name.
    ['main', 'canopycms/prod/', 'main'],
    ['feature/x', 'canopycms/prod/', 'feature/x'],
    ['canopycms/prod-eu/spring', 'canopycms/prod/', 'canopycms/prod-eu/spring'],
    ['canopycms/prod/spring', null, 'canopycms/prod/spring'],
    // The namespace alone names no branch in it.
    ['canopycms/prod/', 'canopycms/prod/', 'canopycms/prod/'],
    // A branch nested deeper keeps its full name: a short name holding a "/" is a full name.
    ['canopycms/prod/a/b', 'canopycms/prod/', 'canopycms/prod/a/b'],
  ])('calls %s in %j %s', (name, namespace, shortName) => {
    expect(branchShortName(name, namespace)).toBe(shortName)
  })
})
