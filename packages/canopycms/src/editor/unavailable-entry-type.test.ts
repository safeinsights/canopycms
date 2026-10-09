import { describe, expect, it } from 'vitest'

import { unavailableSchemaRefs, unavailableTypeMessageParts } from './unavailable-entry-type'

/** The message as `UnavailableTypeMessage` renders it, refs comma-joined, as plain text. */
const unavailableTypeMessage = (refs: readonly string[]) => {
  const { before, after } = unavailableTypeMessageParts(refs)
  return `${before}${refs.join(', ')}${after}`
}

describe('the unavailable-type message', () => {
  it('names the schema ref in the shared wording', () => {
    expect(unavailableTypeMessage(['widgetSchema'])).toBe(
      "This section uses a content type this editor version doesn't know yet (widgetSchema). It usually appears after the editor finishes updating; reload in a few minutes.",
    )
  })

  it('joins several refs and omits the parenthetical when there is none', () => {
    expect(unavailableTypeMessage(['a', 'b'])).toContain('(a, b).')
    expect(unavailableTypeMessage([])).toBe(
      "This section uses a content type this editor version doesn't know yet. It usually appears after the editor finishes updating; reload in a few minutes.",
    )
  })

  it('splits around the refs so a renderer can style them', () => {
    const { before, after } = unavailableTypeMessageParts(['widgetSchema'])
    expect(before.endsWith('(')).toBe(true)
    expect(after.startsWith(').')).toBe(true)
  })
})

describe('unavailableSchemaRefs', () => {
  it('lists the distinct refs of the unavailable types only', () => {
    const unavailable = (schemaRef: string) => ({ schemaRef })
    expect(
      unavailableSchemaRefs([
        { unavailable: unavailable('widgetSchema') },
        {},
        { unavailable: unavailable('widgetSchema') },
        { unavailable: unavailable('gadgetSchema') },
      ]),
    ).toEqual(['widgetSchema', 'gadgetSchema'])
    expect(unavailableSchemaRefs(undefined)).toEqual([])
  })
})
