/**
 * Helper functions for authoring CanopyCMS configuration files.
 */

import { validateCanopyConfig } from './validation'
import type {
  CanopyConfig,
  CanopyConfigFragment,
  CanopyConfigInput,
  CanopyClientConfig,
  ClientOnlyFields,
} from './types'

export type CanopyConfigAuthoring = CanopyConfigInput

/**
 * Helper for authoring typed config files (canopycms.config.ts).
 * Performs runtime validation using the CanopyConfig schema.
 * Returns a bundle with `server` (full config) and `client(overrides)` (safe subset).
 *
 * Schemas live in `.collection.json` files alongside your content, referenced
 * through `createEntrySchemaRegistry` in your `schemas.ts`. See README
 * "Setting Up a Schema Registry".
 *
 * @example
 * ```ts
 * // canopycms.config.ts
 * import { defineCanopyConfig } from 'canopycms'
 *
 * export default defineCanopyConfig({
 *   mode: 'dev',
 *   gitBotAuthorName: 'My CMS Bot',
 *   gitBotAuthorEmail: 'bot@example.com',
 *   editor: {
 *     title: 'My Editor',
 *   },
 * })
 * ```
 */
export function defineCanopyConfig(config: CanopyConfigInput | CanopyConfigAuthoring) {
  const validated = validateCanopyConfig(config as CanopyConfigInput)

  return {
    // Full server config - all fields including sensitive data
    server: validated,

    // Client config helper - extracts safe subset and merges overrides
    // Note: flatSchema is loaded dynamically by the editor via API (from .collection.json files)
    client: (clientOverrides?: ClientOnlyFields): CanopyClientConfig => {
      const { defaultBaseBranch, defaultActiveBranch, contentRoot, editor, mode, entryLinkUrl } =
        validated
      const clientConfig: CanopyClientConfig = {
        defaultBaseBranch,
        defaultActiveBranch,
        contentRoot,
        editor,
        mode,
        entryLinkUrl,
        flatSchema: [], // Loaded dynamically by editor via API
      }

      // Merge client overrides (e.g., auth handlers from useClerkAuthConfig)
      if (clientOverrides?.editor) {
        clientConfig.editor = {
          ...clientConfig.editor,
          ...clientOverrides.editor,
        }
      }

      return clientConfig
    },
  }
}

/**
 * Assigns `value` onto `target[key]` unless `value` is undefined.
 * Used by `composeCanopyConfig` to merge fragments key-by-key without a later
 * fragment's absent (undefined) field clobbering a value set by an earlier one.
 */
function assignFragmentField<K extends keyof CanopyConfigFragment>(
  target: Partial<CanopyConfigInput>,
  key: K,
  value: CanopyConfigFragment[K],
): void {
  if (value !== undefined) {
    target[key] = value
  }
}

/**
 * Helper to compose config fragments defined across multiple files.
 * Useful for splitting large configurations into domain-specific modules.
 *
 * Merges every field declared on `CanopyConfigFragment` (i.e. every field of
 * `CanopyConfigInput`) — not just a hand-picked subset — so adopters can put any
 * config field (including `authPlugin`, `validateEntry`, `editor`, etc.) into any
 * fragment without it being silently dropped.
 *
 * Fragments are applied in order and later fragments win field-by-field: if a later
 * fragment sets a field, it overrides an earlier one; if a later fragment omits a
 * field (leaves it undefined), the earlier fragment's value is preserved.
 *
 * @example
 * ```ts
 * // posts.config.ts
 * export const postsConfig = { media: {...}, contentRoot: 'content/posts' }
 *
 * // canopycms.config.ts
 * import { composeCanopyConfig } from 'canopycms'
 * import { postsConfig } from './posts.config'
 * import { pagesConfig } from './pages.config'
 *
 * export const config = composeCanopyConfig(postsConfig, pagesConfig)
 * ```
 */
export const composeCanopyConfig = (...fragments: CanopyConfigFragment[]): CanopyConfig => {
  const merged: Partial<CanopyConfigInput> = {}

  for (const fragment of fragments) {
    for (const key of Object.keys(fragment) as (keyof CanopyConfigFragment)[]) {
      assignFragmentField(merged, key, fragment[key])
    }
  }

  return validateCanopyConfig({
    ...merged,
    // gitBotAuthorName/gitBotAuthorEmail are required by CanopyConfigInput; default to ''
    // so a fragment set omitting them fails validation (min length / email format) with a
    // clear error rather than a TS/runtime "missing required field" surprise.
    gitBotAuthorName: merged.gitBotAuthorName ?? '',
    gitBotAuthorEmail: merged.gitBotAuthorEmail ?? '',
  })
}
