/**
 * The keys a block item carries that are STRUCTURE rather than content.
 *
 * A block on disk is `{ template: 'hero', value: { ...fields } }` — the canonical shape the
 * editor writes and `ContentStore` persists — or, defensively, the inline `{ _type: 'hero',
 * ...fields }` shape (see `resolveBlockItem` in `./field-traversal`). Either way the
 * discriminator names the block's TEMPLATE, which is a category label shared by every block of
 * that kind, not an identifier for this particular block.
 *
 * That distinction matters to two callers for opposite-looking reasons, which is why the list
 * lives here rather than in either of them:
 *
 * - `findUnknownKeys` (./entry-validator) must not report the discriminator as a stale key: it
 *   is not a schema field, but it is supposed to be there.
 * - `looksLikeSameItem` (../utils/content-serialize) must not accept the discriminator as
 *   evidence that two list items are the same item: two `hero` blocks share `template: hero`,
 *   so counting it migrated an editorial comment off a deleted block onto an unrelated
 *   survivor.
 *
 * A single list keeps those two from drifting apart — a third discriminator added for one of
 * them but not the other would resurrect exactly one of those bugs.
 *
 * Note that two other readers deliberately still spell the keys out themselves, because they
 * READ the discriminator's value positionally rather than testing membership, and they do not
 * agree on precedence: `resolveBlockItem` prefers `template`, while `ai/json-to-markdown.ts`
 * prefers `_type`. Reconciling that is a behaviour question, not a refactor — see
 * `.claude/future-tasks/block-discriminator-precedence-disagreement.md`.
 *
 * Dependency-free on purpose: both importers are reachable from contexts that must not pull in
 * schema types or node built-ins.
 */

/**
 * The discriminator keys, in the precedence `resolveBlockItem` reads them.
 *
 * Ordered (rather than a bare Set) so a caller that needs the VALUE can iterate it, and so the
 * canonical shape's key stays visibly first.
 */
export const BLOCK_DISCRIMINATOR_KEYS = ['template', '_type'] as const

/** Membership form of {@link BLOCK_DISCRIMINATOR_KEYS}, for the two set-test callers. */
export const BLOCK_STRUCTURAL_KEYS: ReadonlySet<string> = new Set(BLOCK_DISCRIMINATOR_KEYS)

/** True for a key that names a block's template rather than holding any of its content. */
export function isBlockStructuralKey(key: string): boolean {
  return BLOCK_STRUCTURAL_KEYS.has(key)
}
