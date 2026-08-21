/**
 * Main CanopyConfig Zod schema - composes all sub-schemas.
 */

import { z } from 'zod'

import type { AuthPlugin } from '../../auth/plugin'
import type { EntryLinkUrlResolver } from '../../entry-link-resolver'
import type { ValidateEntryHook } from '../types'
import { relativePathSchema } from './collection'
import { mediaSchema } from './media'

// Default value schemas
export const defaultBranchAccessSchema = z.enum(['allow', 'deny']).default('deny')
export const defaultPathAccessLevelSchema = z.enum(['allow', 'deny'])
// Per-level object form: an omitted level stays undefined after parse (no per-field
// defaults here) so the runtime resolver (resolveDefaultPathAccess) can fail closed to
// 'deny' for any level the config author didn't explicitly scope.
export const defaultPathAccessLevelsSchema = z
  .object({
    read: defaultPathAccessLevelSchema.optional(),
    edit: defaultPathAccessLevelSchema.optional(),
    review: defaultPathAccessLevelSchema.optional(),
  })
  .strict()
export const defaultPathAccessSchema = z
  .union([defaultPathAccessLevelSchema, defaultPathAccessLevelsSchema])
  .default('deny')
export const defaultBaseBranchSchema = z.string().default('main')
export const defaultRemoteNameSchema = z.string().default('origin')
export const defaultRemoteUrlSchema = z.string().min(1)
export const gitBotAuthorNameSchema = z.string().min(1)
export const gitBotAuthorEmailSchema = z.string().email()
export const githubTokenEnvVarSchema = z.string().default('GITHUB_BOT_TOKEN')
export const operatingModeSchema = z.enum(['prod', 'dev'])
export const deployedAsSchema = z.enum(['static', 'server']).default('server')
export const contentRootSchema = relativePathSchema.default('content')
export const sourceRootSchema = z.string().min(1).optional()
// Lenient on shape (leading/trailing slashes, absolute-URL prefixes) -- `joinUrlPrefix`
// normalizes all of that at every use site. Only reject a value that is nothing but
// whitespace, since that can never be a meaningful deployment prefix and most likely
// indicates a copy-paste/templating mistake in the adopter's config.
export const basePathSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    message: 'basePath must not be empty or only whitespace',
  })
  .optional()
export const deploymentNameSchema = z.string().default('prod')
export const devContentSyncSchema = z.enum(['off', 'warn']).default('warn')

// Dev-mode-only behavior. Ignored when mode !== 'dev'.
export const devConfigSchema = z.object({
  contentSync: devContentSyncSchema.optional(),
})

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

// Main CanopyConfig schema.
export const CanopyConfigSchema = z
  .object({
    media: mediaSchema.optional(),
    // No outer .optional() here: defaultBranchAccessSchema/defaultPathAccessSchema already
    // have .default('deny'), so the field is optional on input but always resolves to
    // 'allow'/'deny' (never undefined) on output. An outer .optional() would short-circuit
    // before the inner default runs, defeating the fail-closed default (SCH-M1).
    // defaultPathAccessSchema's union keeps the same rule: the .default('deny') sits on the
    // OUTER union, not inside defaultPathAccessLevelsSchema, so an omitted top-level field
    // still resolves to 'deny' and an omitted level inside the object form stays undefined
    // (resolved to 'deny' at read time by resolveDefaultPathAccess).
    defaultBranchAccess: defaultBranchAccessSchema,
    defaultPathAccess: defaultPathAccessSchema,
    // .optional() deliberately defeats defaultBaseBranchSchema's .default('main'):
    // unset must stay undefined after parsing so dev mode can detect the fork
    // point from git HEAD (see resolveBaseBranch in utils/git.ts).
    defaultBaseBranch: defaultBaseBranchSchema.optional(),
    defaultActiveBranch: z.string().min(1).optional(),
    defaultRemoteName: defaultRemoteNameSchema.optional(),
    defaultRemoteUrl: defaultRemoteUrlSchema.optional(),
    gitBotAuthorName: gitBotAuthorNameSchema,
    gitBotAuthorEmail: gitBotAuthorEmailSchema,
    githubTokenEnvVar: githubTokenEnvVarSchema.optional(),
    // Required by design (follow-up to SEC-C1): a prod deploy that omits `mode` must fail
    // validation loudly rather than silently running header-trusting dev auth semantics.
    mode: operatingModeSchema,
    deployedAs: deployedAsSchema, // Has .default('server'), so always present after validation
    // Escape hatch for prod hosts that genuinely have internet access and intentionally
    // run git against a network remote (see GitManager.resolveRemoteUrl's prod-mode guard).
    // Default false/unset — the standard AWS Lambda+worker topology must leave this unset.
    allowNetworkRemoteInProd: z.boolean().optional(),
    settingsBranch: z.string().optional(),
    autoCreateSettingsPR: z.boolean().optional(),
    // Deliberately `deploymentNameSchema.optional()`, NOT `deploymentNameSchema` alone.
    // deploymentNameSchema.default('prod') would make `parse(undefined)` resolve to
    // the literal 'prod' instead of staying `undefined` — collapsing the
    // env > config > modeDefault precedence chain that resolveDeploymentName
    // (operating-mode/deployment-name.ts) implements: config would then always
    // "win" over modeDefault (masking dev's real default of 'local'), and the env
    // var would just be racing config's baked-in 'prod' instead of a true absence.
    // `.optional()` here is what keeps an omitted deploymentName reaching
    // resolveDeploymentName as `undefined`, so it can fall through to modeDefault.
    // Do not "fix" this by removing `.optional()`.
    deploymentName: deploymentNameSchema.optional(),
    contentRoot: contentRootSchema.default('content'),
    sourceRoot: sourceRootSchema.optional(),
    basePath: basePathSchema,
    editor: editorConfigSchema.optional(),
    authPlugin: z.custom<AuthPlugin>().optional(),
    entryLinkUrl: z.custom<EntryLinkUrlResolver>().optional(),
    validateEntry: z.custom<ValidateEntryHook>().optional(),
    dev: devConfigSchema.optional(),
  })
  .strict()

/**
 * Helper to get schema default values.
 * This centralizes default value extraction from Zod schemas.
 */
/**
 * Default workspace path for prod mode (used when CANOPYCMS_WORKSPACE_ROOT is not set).
 *
 * WARNING: this fallback assumes a worker-style ROOT mount of EFS at /mnt/efs.
 * The CanopyCmsService Lambda mounts EFS THROUGH an access point already rooted
 * at /workspace and therefore sets CANOPYCMS_WORKSPACE_ROOT=/mnt/efs explicitly;
 * if that env were ever unset on the Lambda this default would resolve to
 * /mnt/efs/workspace = EFS:/workspace/workspace (a wrong, nested dir). The CDK
 * always sets the env, so this only bites a hand-rolled misconfiguration.
 */
export const DEFAULT_PROD_WORKSPACE = '/mnt/efs/workspace'

// Note: `mode` has no default by design (SEC-C1) and is intentionally omitted here —
// operatingModeSchema.parse(undefined) would throw.
//
// `deploymentName` is ALSO deliberately omitted here (checked every caller,
// 2026-07-30: only packages/canopycms/src/services.ts reads from this return
// value, and only `.remoteName`; nothing ever read `.deploymentName`). Unlike
// the defaults below, deploymentName's real default is mode-dependent — 'prod'
// for ProdStrategy, 'local' for DevStrategy (see
// operating-mode/client-unsafe-strategy.ts's getSettingsBranchName, which
// resolves it via resolveDeploymentName) — and this accessor has no mode to
// select between them. Emitting `deploymentNameSchema.parse(undefined)`
// ('prod') here would silently lie for dev mode; better to have no caller of
// this than a mode-blind one.
export const getConfigDefaults = () => ({
  baseBranch: defaultBaseBranchSchema.parse(undefined),
  remoteName: defaultRemoteNameSchema.parse(undefined),
  pathAccess: defaultPathAccessSchema.parse(undefined),
  branchAccess: defaultBranchAccessSchema.parse(undefined),
  contentRoot: contentRootSchema.parse(undefined),
  githubTokenEnvVar: githubTokenEnvVarSchema.parse(undefined),
  prodWorkspace: DEFAULT_PROD_WORKSPACE,
})
