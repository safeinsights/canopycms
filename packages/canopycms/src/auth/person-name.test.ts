import { describe, it, expect } from 'vitest'
import { personInitials, personName } from './person-name'

describe('personName', () => {
  it('returns a real name, trimmed', () => {
    expect(personName('user_1', '  Alice Smith ')).toBe('Alice Smith')
  })

  it('returns undefined for a missing, empty or blank name', () => {
    expect(personName('user_1', undefined)).toBeUndefined()
    expect(personName('user_1', '')).toBeUndefined()
    expect(personName('user_1', '  \t ')).toBeUndefined()
  })

  it('returns undefined for a name equal to the id, however padded', () => {
    expect(personName('user_1', 'user_1')).toBeUndefined()
    expect(personName('user_1', ' user_1 ')).toBeUndefined()
  })

  it('keeps a name that merely contains the id', () => {
    expect(personName('bob', 'Bob')).toBe('Bob')
    expect(personName('bob', 'bobby')).toBe('bobby')
  })
})

describe('personInitials', () => {
  it('takes the first and last names, or one name alone', () => {
    expect(personInitials('User Two')).toBe('UT')
    expect(personInitials('Ana Maria Lee')).toBe('AL')
    expect(personInitials('Cher')).toBe('C')
  })

  it('never cuts an emoji or other astral character in half', () => {
    expect(personInitials('🦊 Fox')).toBe('🦊F')
    expect(personInitials('𝒜da')).toBe('𝒜')
  })
})
