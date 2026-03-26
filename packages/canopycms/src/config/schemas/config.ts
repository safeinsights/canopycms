/**
 * Main CanopyConfig Zod schema - composes all sub-schemas.
 */

import { z } from 'zod'

import type { AuthPlugin } from '../../auth/plugin'
import { rootCollectionSchema, relativePathSchema } from './collection'
import { mediaSchema } from './media'

// Default value schemas
export const defaultBranchAccessSchema = z.enum(['allow', 'deny']).default('deny')
export const defaultPathAccessSchema = z.enum(['allow', 'deny']).default('deny')
export const defaultBaseBranchSchema = z.string().default('main')
export const defaultRemoteNameSchema = z.string().default('origin')
export const defaultRemoteUrlSchema = z.string().min(1)
export const gitBotAuthorNameSchema = z.string().min(1)
export const gitBotAuthorEmailSchema = z.string().email()
export const githubTokenEnvVarSchema = z.string().default('GITHUB_BOT_TOKEN')
export const operatingModeSchema = z.enum(['prod', 'prod-sim', 'dev']).default('dev')
export const deployedAsSchema = z.enum(['static', 'server']).default('server')
export const contentRootSchema = relativePathSchema.default('content')
export const sourceRootSchema = z.string().min(1).optional()
export const deploymentNameSchema = z.string().default('prod')

// Editor configuration schema
export const editorConfigSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  theme: z.unknown().optional(),
  previewBase: z.record(z.string()).optional(),
  // UI handler functions (runtime only, don't serialize)
  onAccountClick: z.function().returns(z.void()).optional(),
  onLogoutClick: z.function().returns(z.void()).optional(),
  // Optional: custom account component (e.g., Clerk's UserButton)
  AccountComponent: z.custom<React.ComponentType>().optional(),
})

// Main CanopyConfig schema
export const CanopyConfigSchema = z.object({
  schema: rootCollectionSchema.optional(),
  media: mediaSchema.optional(),
  defaultBranchAccess: defaultBranchAccessSchema.optional(),
  defaultPathAccess: defaultPathAccessSchema.optional(),
  defaultBaseBranch: defaultBaseBranchSchema.optional(),
  defaultRemoteName: defaultRemoteNameSchema.optional(),
  defaultRemoteUrl: defaultRemoteUrlSchema.optional(),
  gitBotAuthorName: gitBotAuthorNameSchema,
  gitBotAuthorEmail: gitBotAuthorEmailSchema,
  githubTokenEnvVar: githubTokenEnvVarSchema.optional(),
  mode: operatingModeSchema, // Has .default(), so not optional in output type
  deployedAs: deployedAsSchema, // Has .default('server'), so always present after validation
  settingsBranch: z.string().optional(),
  autoCreateSettingsPR: z.boolean().optional(),
  deploymentName: deploymentNameSchema.optional(),
  contentRoot: contentRootSchema.default('content'),
  sourceRoot: sourceRootSchema.optional(),
  editor: editorConfigSchema.optional(),
  authPlugin: z.custom<AuthPlugin>().optional(),
})

/**
 * Helper to get schema default values.
 * This centralizes default value extraction from Zod schemas.
 */
/** Default workspace path for prod mode (used when CANOPYCMS_WORKSPACE_ROOT is not set) */
export const DEFAULT_PROD_WORKSPACE = '/mnt/efs/workspace'

export const getConfigDefaults = () => ({
  baseBranch: defaultBaseBranchSchema.parse(undefined),
  remoteName: defaultRemoteNameSchema.parse(undefined),
  pathAccess: defaultPathAccessSchema.parse(undefined),
  branchAccess: defaultBranchAccessSchema.parse(undefined),
  contentRoot: contentRootSchema.parse(undefined),
  mode: operatingModeSchema.parse(undefined),
  githubTokenEnvVar: githubTokenEnvVarSchema.parse(undefined),
  deploymentName: deploymentNameSchema.parse(undefined),
  prodWorkspace: DEFAULT_PROD_WORKSPACE,
})
