import type { FieldConfig, ObjectFieldConfig } from '../../config'

const MAX_TITLE_LENGTH = 60

const shorten = (text: string): string =>
  text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text

/** The item's own fields, with inline groups opened up, since groups are transparent to values. */
const flattenFields = (fields: readonly FieldConfig[]): FieldConfig[] =>
  fields.flatMap((f) => (f.type === 'group' && 'fields' in f ? flattenFields(f.fields) : [f]))

/**
 * What an object-list item is called: its `itemTitleField` value when that is a non-blank
 * string or a number, else its first non-blank single-line text field, else undefined.
 */
export const listItemTitle = (
  item: unknown,
  objectField: Pick<ObjectFieldConfig, 'fields' | 'itemTitleField'>,
): string | undefined => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
  const record = item as Record<string, unknown>
  const raw = objectField.itemTitleField ? record[objectField.itemTitleField] : undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.trim() !== '') return shorten(raw.trim())
  const text = flattenFields(objectField.fields)
    .filter((f) => f.type === 'string' && !f.list)
    .map((f) => record[f.name])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return text === undefined ? undefined : shorten(text.trim())
}

/** An object-list item's card heading: its title, else "Item N" (1-based). */
export const listItemHeading = (
  item: unknown,
  objectField: Pick<ObjectFieldConfig, 'fields' | 'itemTitleField'>,
  index: number,
): string => listItemTitle(item, objectField) ?? `Item ${index + 1}`
