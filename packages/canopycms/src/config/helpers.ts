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
  ContentRoot,
  DefaultBaseBranch,
  DefaultBranchAccess,
  DefaultPathAccess,
  DefaultRemoteName,
  DefaultRemoteUrl,
  GitBotAuthorEmail,
  GitBotAuthorName,
  CanopyOperatingMode,
  MediaConfig,
  SourceRoot,
} from './types'

export type CanopyConfigAuthoring = CanopyConfigInput

/**
 * Helper for authoring typed config files (canopycms.config.ts).
 * Performs runtime validation using the CanopyConfig schema.
 * Returns a bundle with `server` (full config) and `client(overrides)` (safe subset).
 *
 * @example
 * ```ts
 * // canopycms.config.ts
 * import { defineCanopyConfig } from 'canopycms'
 *
 * export const canopyConfig = defineCanopyConfig({
 *   gitBotAuthorName: 'Bot',
 *   gitBotAuthorEmail: 'bot@example.com',
 *   schema: {
 *     collections: [...]
 *   }
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
      const { defaultBaseBranch, contentRoot, editor, mode } = validated
      const clientConfig: CanopyClientConfig = {
        defaultBaseBranch,
        contentRoot,
        editor,
        mode,
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
 * Helper to compose config fragments defined across multiple files.
 * Useful for splitting large configurations into domain-specific modules.
 * Later fragments can override media.
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
  let media: MediaConfig | undefined
  let contentRoot: ContentRoot | undefined
  let sourceRoot: SourceRoot | undefined
  let defaultBranchAccess: DefaultBranchAccess | undefined
  let defaultPathAccess: DefaultPathAccess | undefined
  let defaultBaseBranch: DefaultBaseBranch | undefined
  let defaultRemoteName: DefaultRemoteName | undefined
  let defaultRemoteUrl: DefaultRemoteUrl | undefined
  let gitBotAuthorName: GitBotAuthorName | undefined
  let gitBotAuthorEmail: GitBotAuthorEmail | undefined
  let mode: CanopyOperatingMode | undefined
  let deploymentName: string | undefined

  for (const fragment of fragments) {
    if (fragment.media) {
      media = fragment.media
    }
    if (fragment.contentRoot) {
      contentRoot = fragment.contentRoot
    }
    if (fragment.sourceRoot) {
      sourceRoot = fragment.sourceRoot
    }
    if (fragment.defaultBranchAccess) {
      defaultBranchAccess = fragment.defaultBranchAccess
    }
    if (fragment.defaultPathAccess) {
      defaultPathAccess = fragment.defaultPathAccess
    }
    if (fragment.defaultBaseBranch) {
      defaultBaseBranch = fragment.defaultBaseBranch
    }
    if (fragment.defaultRemoteName) {
      defaultRemoteName = fragment.defaultRemoteName
    }
    if (fragment.defaultRemoteUrl) {
      defaultRemoteUrl = fragment.defaultRemoteUrl
    }
    if (fragment.gitBotAuthorName) {
      gitBotAuthorName = fragment.gitBotAuthorName
    }
    if (fragment.gitBotAuthorEmail) {
      gitBotAuthorEmail = fragment.gitBotAuthorEmail
    }
    if (fragment.mode) {
      mode = fragment.mode
    }
    if (fragment.deploymentName) {
      deploymentName = fragment.deploymentName
    }
  }

  const merged: CanopyConfigInput = {
    gitBotAuthorName: gitBotAuthorName ?? '',
    gitBotAuthorEmail: gitBotAuthorEmail ?? '',
    ...(media ? { media } : {}),
    ...(contentRoot ? { contentRoot } : {}),
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(defaultBranchAccess ? { defaultBranchAccess } : {}),
    ...(defaultPathAccess ? { defaultPathAccess } : {}),
    ...(defaultBaseBranch ? { defaultBaseBranch } : {}),
    ...(defaultRemoteName ? { defaultRemoteName } : {}),
    ...(defaultRemoteUrl ? { defaultRemoteUrl } : {}),
    ...(gitBotAuthorName ? { gitBotAuthorName } : {}),
    ...(gitBotAuthorEmail ? { gitBotAuthorEmail } : {}),
    ...(mode ? { mode } : {}),
    ...(deploymentName ? { deploymentName } : {}),
  }

  return validateCanopyConfig(merged)
}
