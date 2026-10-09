/**
 * Source-preserving serialisation for JSON content files.
 *
 * A value `data` leaves alone keeps its bytes in the file; a value that changed is re-rendered
 * by jsonc-parser at its own slot, in the file's indent and line ending; and anything this
 * module cannot vouch for (a file that is not a JSON object, an edit set that does not read
 * back as `data`) is written as `JSON.stringify(data, null, 2)`. Retained keys keep the file's
 * order and new keys are appended.
 */

import { isDeepStrictEqual } from 'node:util'

import { applyEdits, modify, type FormattingOptions, type JSONPath } from 'jsonc-parser'

import { createDebugLogger } from './debug'
import { getErrorMessage } from './error'

const log = createDebugLogger({ prefix: 'JsonSourceSplice' })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainStringify(data: Record<string, unknown>): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

/** The file's own indent (from its first indented line) and line ending. */
function detectFormatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1]
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
  return { insertSpaces: true, tabSize: indent?.length ?? 2, eol }
}

/**
 * Append `key: value` to the object at `path`. A formatted `modify` re-renders the object's
 * previous last member too, so when the object's closing brace has a line of its own the member
 * is rendered here in the object's own indent and nothing else is touched; any other layout
 * (an empty or one-line object) takes the formatted `modify`.
 */
function insertMember(
  text: string,
  path: JSONPath,
  key: string,
  value: unknown,
  formattingOptions: FormattingOptions,
): string {
  const at = [...path, key]
  const [edit] = modify(text, at, value, {})
  const closing = edit ? /^[ \t]*\r?\n([ \t]*)\}/.exec(text.slice(edit.offset)) : null
  if (edit && closing && edit.length === 0 && edit.content.startsWith(',')) {
    const unit = formattingOptions.insertSpaces ? ' '.repeat(formattingOptions.tabSize ?? 2) : '\t'
    const eol = formattingOptions.eol ?? '\n'
    const indent = closing[1] + unit
    const rendered = JSON.stringify(value, null, unit)
      .split('\n')
      .join(eol + indent)
    return applyEdits(text, [
      { ...edit, content: `,${eol}${indent}${JSON.stringify(key)}: ${rendered}` },
    ])
  }
  return applyEdits(text, modify(text, at, value, { formattingOptions }))
}

/**
 * Remove the member at `path`. Unformatted, since a formatted removal re-renders the neighbouring
 * member too; and an unformatted removal of an object's first member runs from the `{` to the
 * next member, taking the whitespace in front of it, so a removal that starts in whitespace and
 * ends at a member starts at the removed member instead.
 */
function removeMember(text: string, path: JSONPath): string {
  return applyEdits(
    text,
    modify(text, path, undefined, {}).map((edit) => {
      const removed = text.slice(edit.offset, edit.offset + edit.length)
      const lead = /^\s+/.exec(removed)?.[0].length ?? 0
      const atMember = /\S/.test(text.charAt(edit.offset + edit.length))
      return edit.content === '' && lead > 0 && atMember
        ? { ...edit, offset: edit.offset + lead, length: edit.length - lead }
        : edit
    }),
  )
}

/**
 * Edit `text` so the value at `path` goes from `before` to `after`, touching only what differs.
 * Both sides are JSON-normalised, so `undefined` never appears and a key is absent or present.
 */
function reconcile(
  text: string,
  path: JSONPath,
  before: unknown,
  after: unknown,
  formattingOptions: FormattingOptions,
): string {
  if (isRecord(before) && isRecord(after)) {
    // Removing every member one by one would leave the braces on their own lines.
    if (Object.keys(after).length === 0 && Object.keys(before).length > 0) {
      return applyEdits(text, modify(text, path, {}, { formattingOptions }))
    }
    let next = text
    for (const key of Object.keys(before)) {
      if (!Object.prototype.hasOwnProperty.call(after, key))
        next = removeMember(next, [...path, key])
    }
    for (const key of Object.keys(after)) {
      next = Object.prototype.hasOwnProperty.call(before, key)
        ? reconcile(next, [...path, key], before[key], after[key], formattingOptions)
        : insertMember(next, path, key, after[key], formattingOptions)
    }
    return next
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return after.reduce<string>(
      (next, item, index) =>
        reconcile(next, [...path, index], before[index], item, formattingOptions),
      text,
    )
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return text
  return applyEdits(text, modify(text, path, after, { formattingOptions }))
}

/**
 * Serialise entry data as a JSON file, keeping `existingRaw`'s formatting wherever `data`
 * leaves a value alone. Writes `JSON.stringify(data, null, 2)` plus a newline when there is
 * no existing file or the splice cannot be trusted; a save never fails on the old content.
 */
export function serializeJson(data: Record<string, unknown>, existingRaw?: string): string {
  if (existingRaw === undefined) return plainStringify(data)
  try {
    const normalised: unknown = JSON.parse(JSON.stringify(data))
    const existing: unknown = JSON.parse(existingRaw)
    if (!isRecord(normalised) || !isRecord(existing)) return plainStringify(data)

    const spliced = reconcile(existingRaw, [], existing, normalised, detectFormatting(existingRaw))
    if (isDeepStrictEqual(JSON.parse(spliced), normalised)) return spliced
    log.debug('json-source-splice', 'splice does not read back as data; writing JSON.stringify')
  } catch (err: unknown) {
    log.debug('json-source-splice', 'splice failed; writing JSON.stringify', {
      error: getErrorMessage(err),
    })
  }
  return plainStringify(data)
}
