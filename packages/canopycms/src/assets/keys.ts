/**
 * Pure key/hash/slug helpers for the asset store. No filesystem or network I/O
 * here — keeps this file trivially unit-testable and safe to reason about for
 * path-traversal / header-injection concerns.
 *
 * Bucket-prefix layout (see .claude/future-tasks/assets-media-system.md):
 *   asset-originals/{hash32}.{ext}          private; full-fidelity originals
 *   asset-staging/{uuid}                    presigned-POST target
 *   asset-meta/{hash32}.json                private; filename/uploader/dims/mime
 *   assets/t/{directives}/{hash32}/{slug}   transform outputs (see transform-directives.ts)
 *   assets/{hash32}/{slug}.{ext}            public static: sanitized SVG + PDF only
 *
 * Stores must build keys through these helpers rather than hand-rolling prefix
 * strings, so the layout stays defined in exactly one place.
 */

import { createHash } from 'node:crypto'

import { ASSET_PREFIXES, type AssetPrefixes } from './asset-prefixes'

export { ASSET_PREFIXES, type AssetPrefixes }

/** sha-256 of the given bytes, truncated to 32 hex chars (128 bits). */
export function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 32)
}

const MAX_SLUG_LENGTH = 80
const MAX_EXT_LENGTH = 10
const FALLBACK_SLUG = 'file'

/**
 * Slugify an (untrusted) original filename into a safe slug + normalized
 * extension. Never trust the input for path or header use directly — this
 * strips directory components, non-ASCII/unsafe characters, and caps length.
 *
 * - Directory components (`/`, `\`, including `..` segments) are dropped —
 *   only the final path segment is considered.
 * - The slug charset is restricted to `[a-z0-9-]`; anything else (spaces,
 *   unicode, punctuation) collapses to a single `-`, with leading/trailing
 *   dashes stripped.
 * - Diacritics are stripped (NFKD) before charset filtering, so an accented
 *   "e"-with-acute-accent becomes plain "e" rather than being dropped entirely.
 * - The extension (text after the last `.` in the final segment) is
 *   lowercased and restricted to `[a-z0-9]`, capped at 10 chars.
 * - An empty/unsafe result falls back to a fixed slug so callers never see
 *   an empty string.
 */
export function slugifyFilename(name: string): { slug: string; ext: string } {
  // Drop any directory components (handles both `/` and `\`, and `..` segments)
  // so the untrusted original filename can never influence a constructed path.
  const segments = name.split(/[/\\]+/)
  const basename = segments[segments.length - 1] ?? ''

  const lastDot = basename.lastIndexOf('.')
  const hasExt = lastDot > 0 && lastDot < basename.length - 1
  const base = hasExt ? basename.slice(0, lastDot) : basename
  const extRaw = hasExt ? basename.slice(lastDot + 1) : ''

  const ext = extRaw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, MAX_EXT_LENGTH)

  // U+0300-U+036F is the combining-diacritical-marks block, stripped after NFKD
  // decomposition. Built from fixed char codes (not a literal regex) so this
  // file's source stays pure ASCII; the pattern is not derived from input, so
  // there is no injection risk despite the non-literal RegExp constructor.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const COMBINING_MARKS = new RegExp(
    `[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`,
    'g',
  )
  let slug = base
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '')

  return { slug: slug || FALLBACK_SLUG, ext }
}

/**
 * Build the key helpers bound to a given prefix set. Stores that support prefix
 * overrides (currently S3AssetStore) call this with their configured prefixes;
 * everyone else uses the default export instances below.
 */
export function createKeyBuilders(prefixes: AssetPrefixes = ASSET_PREFIXES) {
  return {
    originalKey: (hash32: string, ext: string): string => `${prefixes.originals}/${hash32}.${ext}`,
    /** Prefix used to look up an original by hash32 alone (extension unknown ahead of time). */
    originalPrefix: (hash32: string): string => `${prefixes.originals}/${hash32}.`,
    stagingKey: (uuid: string): string => `${prefixes.staging}/${uuid}`,
    metaKey: (hash32: string): string => `${prefixes.meta}/${hash32}.json`,
    metaPrefix: (): string => `${prefixes.meta}/`,
    publicKey: (hash32: string, slug: string, ext: string): string =>
      `${prefixes.public}/${hash32}/${slug}.${ext}`,
  }
}

export const { originalKey, originalPrefix, stagingKey, metaKey, metaPrefix, publicKey } =
  createKeyBuilders()
