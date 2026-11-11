import { describe, expect, it } from 'vitest'

import { buildEntryConflicts, type FieldConflict } from './conflict-cards'
import {
  holdsChoice,
  isDecided,
  textWithChoices,
  withLatest,
  withRegions,
  withYours,
} from './conflict-choices'
import {
  BASE_SHA,
  MERGE_SHA as MERGE,
  conflictFields,
  conflictRecordFields,
  fieldsConflictData,
  mergedBody,
  savedValue,
} from './components/__test__/conflict-fixtures'

const fieldOf = (name: keyof typeof conflictRecordFields): FieldConflict =>
  buildEntryConflicts(fieldsConflictData([name]), conflictFields, 'body').fields[0]

describe('withLatest (row 43: each choice saves the right value)', () => {
  it('takes the latest version’s value for a field both changed', () => {
    const next = withLatest(savedValue, fieldOf('heading'), 'body')
    expect(next?.hero).toEqual({ heading: 'Welcome, editors' })
    expect(next?.summary).toBe(savedValue.summary)
  })

  it('removes a field the latest version removed: "Remove it"', () => {
    const next = withLatest(savedValue, fieldOf('readTime'), 'body')
    expect(next).toBeDefined()
    expect(next && 'readTime' in next).toBe(false)
  })

  it('puts back a field you removed, as the latest version has it: "Keep it"', () => {
    expect(withLatest(savedValue, fieldOf('tagline'), 'body')?.tagline).toBe('Start here today')
  })

  it('removes a list item the latest version removed, leaving the others', () => {
    const next = withLatest(savedValue, fieldOf('step'), 'body')
    expect(next?.steps).toEqual([{ _key: 'k1', text: 'Install' }])
  })

  it('replaces a whole value, an image, with the latest version’s', () => {
    expect(withLatest(savedValue, fieldOf('cover'), 'body')?.cover).toEqual({
      src: '/assets/b2/cover-site.jpg',
      alt: 'A forest path',
    })
  })
})

describe('withYours', () => {
  it('puts your saved value back after a choice', () => {
    const field = fieldOf('summary')
    const chosen = withLatest(savedValue, field, 'body')
    expect(chosen?.summary).toBe('How to begin editing.')
    expect(withYours(chosen ?? {}, savedValue, field, 'body')?.summary).toBe(
      'A guide to your first edit.',
    )
  })
})

describe('textWithChoices', () => {
  const text = fieldOf('body').text
  if (!text) throw new Error('the body should merge by region')

  it('holds your lines in every region left unchosen, as the merge left them', () => {
    expect(textWithChoices(text, {})).toBe(mergedBody)
  })

  it('places each region’s choice where the merge put your lines', () => {
    const chosen = textWithChoices(text, { 0: 'latest', 1: 'yours' })
    expect(chosen).toContain('Install the package with pnpm first.')
    expect(chosen).not.toContain('and its peers')
    expect(chosen).toContain('Ask for help on the issue tracker.')
    expect(chosen.startsWith('# Welcome, editors\n')).toBe(true)
    expect(chosen.endsWith('\n')).toBe(true)
  })

  it('"Use both" puts the latest version’s lines first, then yours (row 24)', () => {
    const chosen = textWithChoices(text, { 1: 'both' })
    expect(chosen).toContain('Ask for help in the chat.\nAsk for help on the issue tracker.\n')
  })

  it('places a later region where the merge put it after an earlier one changed its length', () => {
    expect(textWithChoices(text, { 0: 'both', 1: 'latest' })).toBe(
      [
        '# Welcome, editors',
        '',
        'Install the package with pnpm first.',
        'Install the package and its peers first.',
        '',
        'Then add the route.',
        '',
        'Middle paragraph stays as it is.',
        '',
        'Ask for help in the chat.',
        '',
      ].join('\n'),
    )
  })

  it('writes the chosen text into the form value at the body', () => {
    const next = withRegions(savedValue, fieldOf('body'), { 0: 'latest', 1: 'latest' }, 'body')
    expect(next?.body).toBe(textWithChoices(text, { 0: 'latest', 1: 'latest' }))
    expect(next?.body).not.toContain('issue tracker')
  })
})

describe('holdsChoice', () => {
  it('holds before any choice while the form has your saved value', () => {
    expect(holdsChoice(savedValue, savedValue, fieldOf('summary'), undefined, 'body')).toBe(true)
  })

  it('does not hold once the place was edited by hand, so a choice would lose the edit', () => {
    const edited = { ...savedValue, summary: 'Typed since' }
    expect(holdsChoice(edited, savedValue, fieldOf('summary'), undefined, 'body')).toBe(false)
    expect(holdsChoice(edited, savedValue, fieldOf('summary'), { how: 'latest' }, 'body')).toBe(
      false,
    )
  })

  it('holds after "Use latest version" while the form has the latest value', () => {
    const field = fieldOf('summary')
    const chosen = withLatest(savedValue, field, 'body') ?? {}
    expect(holdsChoice(chosen, savedValue, field, { how: 'latest' }, 'body')).toBe(true)
  })

  it('checks long text against the regions chosen so far', () => {
    const field = fieldOf('body')
    const regions = { 0: 'latest' as const }
    const chosen = withRegions(savedValue, field, regions, 'body') ?? {}
    expect(holdsChoice(chosen, savedValue, field, { how: 'regions', regions }, 'body')).toBe(true)
    const typed = { ...chosen, body: `${String(chosen.body)}More.\n` }
    expect(holdsChoice(typed, savedValue, field, { how: 'regions', regions }, 'body')).toBe(false)
  })
})

describe('isDecided', () => {
  it('decides long text only once every region is chosen', () => {
    const field = fieldOf('body')
    expect(isDecided(field, { how: 'regions', regions: { 0: 'latest' } })).toBe(false)
    expect(isDecided(field, { how: 'regions', regions: { 0: 'latest', 1: 'both' } })).toBe(true)
    expect(isDecided(field, undefined)).toBe(false)
    expect(isDecided(field, { how: 'edited' })).toBe(true)
  })
})

describe('review fixes', () => {
  it('replaces a list item both sides kept in place, keeping the others and their order', () => {
    const field: FieldConflict = {
      key: 'steps.k2',
      mergeSha: MERGE,
      dataPath: [{ field: 'steps' }, { item: 'k2' }],
      item: true,
      cards: [],
      latestPlaceable: true,
      latest: { steps: [{ _key: 'k2', text: 'From the site' }] },
    }
    const next = withLatest(savedValue, field, 'body')
    expect(next?.steps).toEqual([
      { _key: 'k1', text: 'Install' },
      { _key: 'k2', text: 'From the site' },
    ])
    expect(withYours(next ?? {}, savedValue, field, 'body')?.steps).toEqual(savedValue.steps)
  })

  it('places nothing from a latest version that could not be read', () => {
    const data = fieldsConflictData(['heading'])
    data.versions[BASE_SHA] = { unavailable: 'too-large' }
    const field = buildEntryConflicts(data, conflictFields, 'body').fields[0]
    expect(field.latestPlaceable).toBe(false)
    expect(withLatest(savedValue, field, 'body')).toBeUndefined()
  })

  it('places nothing where the latest version lacks an item the place is inside', () => {
    // The latest version holds no item k2, as when the base left its list keyless.
    const data = fieldsConflictData([])
    data.fields = [
      {
        key: 'steps.k2.text',
        drawerKey: 'steps.k2.text',
        dataPath: [{ field: 'steps' }, { item: 'k2' }, { field: 'text' }],
        kind: 'changed',
        mergeSha: MERGE,
        sides: data.sides,
      },
    ]
    const built = buildEntryConflicts(data, conflictFields, 'body').fields[0]
    expect(built.latestPlaceable).toBe(false)
    expect(withLatest(savedValue, built, 'body')).toBeUndefined()
    expect(built.cards[0]).toMatchObject({ type: 'value', latestUnavailable: true })
  })

  it('keeps a region of one blank line as a line, not as nothing', () => {
    const text = {
      merged: 'a\ny\nb\n',
      regions: [{ ancestor: 'x', base: '', branch: 'y', line: 1, lines: 1, baseLines: 1 }],
    }
    expect(textWithChoices(text, { 0: 'latest' })).toBe('a\n\nb\n')
    expect(textWithChoices(text, { 0: 'both' })).toBe('a\n\ny\nb\n')
  })
})
