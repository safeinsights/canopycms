/**
 * What a choice on a conflict card does to the open entry's form value (conflict-cards.ts builds
 * the cards). Pure. A choice is an unsaved edit: the save that writes it sends the conflict's key in
 * `resolvedConflicts` (api/content.ts), which is what resolves it.
 */

import type { TextConflictRegion } from '../merge/text-merge'
import type { FieldConflict } from './conflict-cards'
import type { EntryChange } from './entry-diff'
import { holdsAs, setChangeBack, valueAtChange, withValueAt } from './undo-change'

type FormValue = Record<string, unknown>

/** A region's choice: the latest version's lines, yours, or the latest's followed by yours. */
export type RegionChoice = 'latest' | 'yours' | 'both'

/**
 * `latest`: the latest version's value, which for a removed one removes it. `yours`: your saved
 * value as it stands. `edited`: what the form holds now, marked resolved after an edit. `regions`:
 * long text chosen region by region, resolved once every region is chosen.
 */
export type FieldChoice =
  | { how: 'latest' }
  | { how: 'yours' }
  | { how: 'edited' }
  | { how: 'regions'; regions: Readonly<Record<number, RegionChoice>> }

/** An entry's choices, by conflict key, each for the merge it was made on. */
export type EntryChoices = Readonly<Record<string, { mergeSha: string; choice: FieldChoice }>>

/** The change-shaped handle `undo-change.ts` places a value by. */
export const placeOf = (field: Pick<FieldConflict, 'key' | 'dataPath' | 'item'>): EntryChange => ({
  key: field.key,
  dataPath: field.dataPath,
  path: [],
  kind: 'changed',
  ...(field.item && { item: true as const }),
})

/** Whether a choice says everything its conflict needs. */
export const isDecided = (field: FieldConflict, choice: FieldChoice | undefined): boolean =>
  !!choice &&
  (choice.how !== 'regions' ||
    (!!field.text && field.text.regions.every((_, i) => choice.regions[i] !== undefined)))

const linesOf = (text: string, count?: number): string[] =>
  count === 0 || (count === undefined && text === '') ? [] : text.split('\n')

/** A region's lines under `choice`; undecided, they are yours, as the merge left them. */
const regionLines = (region: TextConflictRegion, choice: RegionChoice | undefined): string[] => {
  const yours = linesOf(region.branch, region.lines)
  // Counted, as the branch's are: joined, one blank line reads as none.
  const latest = linesOf(region.base, region.baseLines)
  if (choice === 'latest') return latest
  if (choice === 'both') return [...latest, ...yours]
  return yours
}

/**
 * The text the merge left with each region as `regions` chooses it. A region's lines sit where the
 * merge put yours (`TextConflictRegion.line`), so regions are placed from the last up.
 * @internal Exported for tests.
 */
export function textWithChoices(
  text: { merged: string; regions: readonly TextConflictRegion[] },
  regions: Readonly<Record<number, RegionChoice>>,
): string {
  const endBreak = text.merged.endsWith('\n')
  const body = endBreak ? text.merged.slice(0, -1) : text.merged
  const lines = body === '' && !endBreak ? [] : body.split('\n')
  for (let i = text.regions.length - 1; i >= 0; i--) {
    const region = text.regions[i]
    lines.splice(region.line, region.lines, ...regionLines(region, regions[i]))
  }
  const joined = lines.join('\n')
  return endBreak ? `${joined}\n` : joined
}

/** What the form would hold at the conflict's place under `choice`, given your saved value. */
const expectedUnder = (
  field: FieldConflict,
  choice: FieldChoice | undefined,
  saved: FormValue,
): { from: FormValue } | { text: string } | undefined => {
  if (!choice || choice.how === 'yours') return { from: saved }
  if (choice.how === 'latest') return field.latest ? { from: field.latest } : undefined
  if (choice.how === 'regions' && field.text)
    return { text: textWithChoices(field.text, choice.regions) }
  return undefined
}

/**
 * Whether the form still holds the conflict's place as the last choice (or, before any, your saved
 * value) left it. False once it was edited by hand: a choice would then replace that edit.
 */
export function holdsChoice(
  current: FormValue,
  saved: FormValue,
  field: FieldConflict,
  choice: FieldChoice | undefined,
  bodyField: string | undefined,
): boolean {
  const expected = expectedUnder(field, choice, saved)
  if (!expected) return true
  if ('text' in expected) return valueAtChange(current, field, bodyField) === expected.text
  // Long text checks the merged text, which your saved value holds until a region is chosen.
  if (field.text && (!choice || choice.how === 'yours')) {
    return valueAtChange(current, field, bodyField) === valueAtChange(saved, field, bodyField)
  }
  return holdsAs(current, expected.from, placeOf(field), bodyField)
}

/**
 * `current` with the conflict's place as `source` has it: a list item `source` lacks taken out, or
 * one `current` lacks put in where `source` has it, through `undo-change.ts`; anything else, an item
 * both hold included, replaced where it is, by key. Undefined when it can't be placed.
 */
const placeFrom = (
  current: FormValue,
  source: FormValue,
  field: FieldConflict,
  bodyField: string | undefined,
): FormValue | undefined => {
  const place = placeOf(field)
  const wanted = valueAtChange(source, place, bodyField)
  if (
    wanted === undefined ||
    (field.item && valueAtChange(current, place, bodyField) === undefined)
  )
    return setChangeBack(current, source, place, bodyField)
  return withValueAt(current, place, structuredClone(wanted), bodyField)
}

/**
 * `current` with the latest version at the conflict's place; undefined when it can't be placed, as
 * where the latest version couldn't be read or doesn't hold the items on the place's path
 * ({@link FieldConflict.latestPlaceable}).
 */
export const withLatest = (
  current: FormValue,
  field: FieldConflict,
  bodyField: string | undefined,
): FormValue | undefined =>
  field.latest && field.latestPlaceable
    ? placeFrom(current, field.latest, field, bodyField)
    : undefined

/** `current` with your saved value back at the conflict's place, as before any choice. */
export const withYours = (
  current: FormValue,
  saved: FormValue,
  field: FieldConflict,
  bodyField: string | undefined,
): FormValue | undefined => placeFrom(current, saved, field, bodyField)

/** `current` with long text as `regions` chooses it. */
export const withRegions = (
  current: FormValue,
  field: FieldConflict,
  regions: Readonly<Record<number, RegionChoice>>,
  bodyField: string | undefined,
): FormValue | undefined =>
  field.text
    ? withValueAt(current, field, textWithChoices(field.text, regions), bodyField)
    : undefined
