/**
 * The keys a block item carries that are STRUCTURE rather than content: the
 * discriminator naming the block's TEMPLATE — a category label shared by every
 * block of that kind, not an identifier for this one — present in either on-disk
 * shape: canonical `{ template: 'hero', value: {...} }` or the defensive inline
 * `{ _type: 'hero', ...fields }` (see `resolveBlockItem` in `./field-traversal`).
 *
 * The list lives here, not in either caller, so the two below can't drift apart:
 * - `findUnknownKeys` (./entry-validator) must not report the discriminator as a
 *   stale key — it isn't a schema field, but is supposed to be there.
 * - `looksLikeSameItem` (../utils/content-serialize) must not accept it as evidence
 *   two list items are the same item — every `hero` shares `template: hero`, so
 *   counting it would migrate an editorial comment off a deleted block onto an
 *   unrelated survivor.
 *
 * Two other readers still spell the keys out themselves — they read the value
 * positionally and disagree on precedence (`resolveBlockItem` prefers `template`,
 * `ai/json-to-markdown.ts` prefers `_type`) — see
 * `.claude/future-tasks/block-discriminator-precedence-disagreement.md`.
 *
 * Dependency-free on purpose: both importers reach contexts that must not pull in
 * schema types or node built-ins.
 */

/**
 * The discriminator keys, in the precedence `resolveBlockItem` reads them. Ordered (not a
 * bare Set) so a caller needing the VALUE can iterate, and the canonical key stays first.
 */
const BLOCK_DISCRIMINATOR_KEYS = ['template', '_type'] as const

/** Membership form of {@link BLOCK_DISCRIMINATOR_KEYS}, for the two set-test callers. */
export const BLOCK_STRUCTURAL_KEYS: ReadonlySet<string> = new Set(BLOCK_DISCRIMINATOR_KEYS)

/** True for a key that names a block's template rather than holding any of its content. */
export function isBlockStructuralKey(key: string): boolean {
  return BLOCK_STRUCTURAL_KEYS.has(key)
}
