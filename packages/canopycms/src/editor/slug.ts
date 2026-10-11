/** Slug derivation and validation shared by the create and rename modals. */

// Imported from '../paths/validation' directly, NOT the `paths` barrel, which pulls
// node:fs into the browser bundle (pnpm lint:bundle enforces this).
import { parseSlug } from '../paths/validation'

const MAX_SLUG_LENGTH = 64

/** A URL slug for a title: ASCII lowercase letters, digits and single hyphens, empty when none remain. */
export function slugFromTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '')
}

/**
 * The message for a slug the user may not use, or null when it is fine.
 *
 * Delegates to `parseSlug` rather than restating its rule: the server refuses to CREATE an
 * entry whose slug fails it (api/content.ts and ContentStore.write's [SLUG] guards), and the
 * static build fails outright on one that slipped through (static/index.ts's
 * assertRoutableSlugs). A second, hand-maintained copy of the charset/length/separator rules
 * here could only ever drift out of agreement with the boundary that actually decides.
 */
export function validateEntrySlug(
  value: string,
  opts: { existingSlugs?: ReadonlySet<string>; currentSlug?: string } = {},
): string | null {
  if (!value.trim()) return 'Enter a slug'
  const parsed = parseSlug(value)
  if (!parsed.ok) return parsed.error
  // `parseSlug` lowercases before testing, so it accepts 'My-Post' and hands back 'my-post'.
  // Keep the field itself strict: the value typed here is what the duplicate check below and
  // the create request are keyed on, so silently normalizing would let 'My-Post' sail past a
  // collision with an existing 'my-post' and land as a 409 from the server instead of an
  // inline message here.
  if (parsed.slug !== value) return 'Use lowercase letters'
  if (value !== opts.currentSlug && opts.existingSlugs?.has(value)) {
    return 'An entry with this slug already exists'
  }
  return null
}
