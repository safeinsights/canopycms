import type { FieldConfig, ObjectFieldConfig, SelectFieldConfig } from '../../config'

const MAX_TITLE_LENGTH = 60

const shorten = (text: string): string =>
  text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text

/** The item's own fields, with inline groups opened up, since groups are transparent to values. */
const flattenFields = (fields: readonly FieldConfig[]): FieldConfig[] =>
  fields.flatMap((f) => (f.type === 'group' && 'fields' in f ? flattenFields(f.fields) : [f]))

const asRecord = (item: unknown): Record<string, unknown> | undefined =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : undefined

/** A value worth showing on one line: a non-blank string's first line, or a finite number. */
const shownText = (raw: unknown): string | undefined => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.trim() !== '') return shorten(raw.trim().split('\n')[0])
  return undefined
}

/** A select's value as its option's label, which is what an editor picked it by. */
const optionLabel = (field: SelectFieldConfig, value: unknown): unknown => {
  const option = (field.options ?? []).find((o) => (typeof o === 'string' ? o : o.value) === value)
  return option === undefined || typeof option === 'string' ? value : option.label
}

/** The item's single-line text fields, in schema order: strings, numbers and single selects. */
const textFields = (fields: readonly FieldConfig[]): FieldConfig[] =>
  flattenFields(fields).filter(
    (f) => (f.type === 'string' || f.type === 'number' || f.type === 'select') && !f.list,
  )

/**
 * Which field titles an object-list item, and its text: its `itemTitleField` value when that is
 * a non-blank string or a number, else its first non-blank single-line string field.
 */
const titleSource = (
  record: Record<string, unknown>,
  objectField: Pick<ObjectFieldConfig, 'fields' | 'itemTitleField'>,
): { name: string; text: string } | undefined => {
  const named = objectField.itemTitleField
  const raw = named ? record[named] : undefined
  if (named && typeof raw === 'number' && Number.isFinite(raw))
    return { name: named, text: String(raw) }
  if (named && typeof raw === 'string' && raw.trim() !== '') {
    return { name: named, text: shorten(raw.trim()) }
  }
  for (const f of flattenFields(objectField.fields)) {
    if (f.type !== 'string' || f.list) continue
    const value = record[f.name]
    if (typeof value === 'string' && value.trim() !== '') {
      return { name: f.name, text: shorten(value.trim()) }
    }
  }
  return undefined
}

/**
 * What an object-list item is called: its `itemTitleField` value when that is a non-blank
 * string or a number, else its first non-blank single-line text field, else undefined.
 */
export const listItemTitle = (
  item: unknown,
  objectField: Pick<ObjectFieldConfig, 'fields' | 'itemTitleField'>,
): string | undefined => {
  const record = asRecord(item)
  return record ? titleSource(record, objectField)?.text : undefined
}

type ItemNaming = Pick<ObjectFieldConfig, 'fields' | 'itemTitleField' | 'itemLabel'>

/** What an untitled item is called by position: "Item 3", or "Team member 3" from `itemLabel`. */
const positionalTitle = (objectField: ItemNaming, index: number): string => {
  const noun = objectField.itemLabel ?? 'item'
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${index + 1}`
}

/** An object-list item's card heading: its title, else its positional title (1-based). */
export const listItemHeading = (item: unknown, objectField: ItemNaming, index: number): string =>
  listItemTitle(item, objectField) ?? positionalTitle(objectField, index)

/**
 * The second value a collapsed row shows beside its title: the first non-blank single-line text
 * field other than the one `exclude` names, so a row never repeats its title.
 */
export const listItemSecondary = (
  item: unknown,
  fields: readonly FieldConfig[],
  exclude?: string,
): string | undefined => {
  const record = asRecord(item)
  if (!record) return undefined
  for (const f of textFields(fields)) {
    if (f.name === exclude) continue
    const text = shownText(
      f.type === 'select' ? optionLabel(f as SelectFieldConfig, record[f.name]) : record[f.name],
    )
    if (text !== undefined) return text
  }
  return undefined
}

/** A collapsed object-list row's title and secondary value. */
export const listItemSummary = (
  item: unknown,
  objectField: ItemNaming,
  index: number,
): { title: string; secondary?: string } => {
  const record = asRecord(item)
  const source = record ? titleSource(record, objectField) : undefined
  return {
    title: source?.text ?? positionalTitle(objectField, index),
    secondary: listItemSecondary(item, objectField.fields, source?.name),
  }
}
