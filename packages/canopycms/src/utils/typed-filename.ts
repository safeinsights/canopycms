import { isValidId } from '../id'
import type { EntryTypeConfig } from '../config'
import type { ContentId, Slug } from '../paths/types'

// Lives here rather than in content-listing.ts, where it was born, purely so dependency-light
// modules can use it: content-listing imports ContentStore, so anything content-store itself
// imports (url-collision.ts) cannot reach back into it without a cycle. content-listing
// re-exports this and `canopycms/server` re-exports it from there, so the public surface is
// unchanged.

/**
 * Parse a Canopy content filename into its `{type}.{slug}.{id}.{ext}` parts.
 *
 * ## Filename grammar
 *
 * Every entry file on disk is named `{type}.{slug}.{id}.{ext}`:
 * - `type` — the entry type name (a key in the collection's `entries` config).
 * - `slug` — the entry's URL slug. May itself contain dots (e.g. a slug of
 *   `getting.started.guide`), so the type and ID anchor the split: the ID is
 *   always the second-to-last dot-separated segment, and the slug is
 *   everything between the type and the ID. The returned `slug` is
 *   lowercased.
 * - `id` — a 12-character Base58 content ID (`generateId()`/`isValidId()`).
 *   Base58 excludes the ambiguous characters `0`, `O`, `I`, `l` so IDs are
 *   unambiguous when read aloud or hand-transcribed. A filename whose
 *   would-be ID segment doesn't pass `isValidId` is rejected — the whole
 *   parse returns `null`, even if the rest of the shape looks right.
 * - `ext` — the format extension (`.md`, `.mdx`, `.json`, `.yaml`), stripped
 *   before parsing and not part of the returned result.
 *
 * @param filename - The bare filename (no directory component). **This precondition is
 *   not enforced.** The parser splits purely on `.`, so a `/` or `\` you pass in is not
 *   rejected and is not treated as special — it becomes part of whichever segment it
 *   falls in, most often the `type` segment (e.g. `'foo/bar.slug.<validId>.md'` parses
 *   to `type: 'foo/bar'`). Strip any directory component yourself (e.g.
 *   `path.basename(filePath)`) before calling this — every internal caller already does.
 * @param entryTypes - When provided, the parsed `type` segment must match one
 *   of these entry types by name, or the parse is rejected (this is how
 *   `listCollectionEntries` filters out files that don't belong to the
 *   collection's configured entry types). Omit this argument to parse
 *   structurally without validating the type against a known list — useful
 *   for adopter code that needs to recover `{type, slug, id}` from a
 *   filename without having a schema/entry-types list on hand (e.g. a
 *   filesystem walk over content for tooling or diagnostics). Even without
 *   `entryTypes`, a leading-dot filename (dotfile, editor swap/backup file)
 *   is always rejected — an empty string is never a legal type, matching the
 *   `filename.startsWith('.')` guard `extractEntryTypeFromFilename` in
 *   `content-id-index.ts` already applies.
 * @returns `{ type, slug, id }`, or `null` if `filename` doesn't match the
 *   `{type}.{slug}.{id}.{ext}` shape (too few segments, no extension, a
 *   leading dot, an invalid ID, or — when `entryTypes` is given — an
 *   unrecognized type). `id` is validated (`isValidId`) and safe to trust. **`slug` is
 *   not** — it is the raw dot-joined middle segment(s), lowercased, cast to the branded
 *   `Slug` type without running `parseSlug`'s validation. A filename with an
 *   unconventional slug segment (e.g. containing a space) still parses and still
 *   receives the `Slug` brand. Callers that need a validated slug must run the result
 *   through `parseSlug` themselves; this function's contract is "split the filename
 *   grammar apart," not "validate every part."
 */
export const parseTypedFilename = (
  filename: string,
  entryTypes?: readonly EntryTypeConfig[],
): { type: string; slug: Slug; id: ContentId } | null => {
  // Reject dotfiles outright (matching extractEntryTypeFromFilename's guard in
  // content-id-index.ts): a leading dot can never be a legal entry type, and this
  // is exactly the shape of the files a structural (no-entryTypes) parse would
  // otherwise misparse -- e.g. '.hidden.file.aB3cD4eF5gH6.md' -> potentialType ''.
  if (filename.startsWith('.')) return null

  // Remove extension
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1) return null
  const nameWithoutExt = filename.slice(0, lastDot)

  // Parse: {type}.{slug}.{id}
  const parts = nameWithoutExt.split('.')
  if (parts.length < 3) return null

  const potentialType = parts[0]
  // When a known-types list is supplied, the first segment must match one of
  // them. Without it, any non-empty first segment is accepted as the type.
  if (entryTypes && !entryTypes.some((e) => e.name === potentialType)) {
    return null
  }

  const id = parts[parts.length - 1]
  if (!isValidId(id)) return null
  const slug = parts.slice(1, -1).join('.').toLowerCase()
  return {
    type: potentialType,
    slug: slug as Slug,
    id: id as ContentId,
  }
}
