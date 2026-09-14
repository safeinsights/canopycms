/**
 * Main CanopyConfig Zod schema - composes all sub-schemas.
 */

import { z } from 'zod'

import type { AuthPlugin } from '../../auth/plugin'
import type { EntryLinkUrlResolver } from '../../entry-link-resolver'
import type { ValidateEntryHook } from '../types'
import { relativePathSchema } from './collection'
import { mediaSchema } from './media'

const defaultBranchAccessSchema = z.enum(['allow', 'deny']).default('deny')
const defaultPathAccessLevelSchema = z.enum(['allow', 'deny'])
// Per-level object form: an omitted level stays undefined after parse (no per-field
// defaults here) so the runtime resolver (resolveDefaultPathAccess) can fail closed to
// 'deny' for any level the config author didn't explicitly scope.
const defaultPathAccessLevelsSchema = z
  .object({
    read: defaultPathAccessLevelSchema.optional(),
    edit: defaultPathAccessLevelSchema.optional(),
    review: defaultPathAccessLevelSchema.optional(),
  })
  .strict()
const defaultPathAccessSchema = z
  .union([defaultPathAccessLevelSchema, defaultPathAccessLevelsSchema])
  .default('deny')
const defaultBaseBranchSchema = z.string().default('main')
const defaultRemoteNameSchema = z.string().default('origin')
const defaultRemoteUrlSchema = z.string().min(1)
const gitBotAuthorNameSchema = z.string().min(1)
const gitBotAuthorEmailSchema = z.string().email()
const githubTokenEnvVarSchema = z.string().default('GITHUB_BOT_TOKEN')
const operatingModeSchema = z.enum(['prod', 'dev'])
const deployedAsSchema = z.enum(['static', 'server']).default('server')
const contentRootSchema = relativePathSchema.default('content')
const sourceRootSchema = z.string().min(1).optional()
// Lenient on shape (leading/trailing slashes, absolute-URL prefixes) -- `joinUrlPrefix`
// normalizes all of that at every use site. Only reject a value that is nothing but
// whitespace, since that can never be a meaningful deployment prefix and most likely
// indicates a copy-paste/templating mistake in the adopter's config.
const basePathSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    message: 'basePath must not be empty or only whitespace',
  })
  .optional()
const deploymentNameSchema = z.string().default('prod')
const devContentSyncSchema = z.enum(['off', 'warn']).default('warn')

// Dev-mode-only behavior. Ignored when mode !== 'dev'.
const devConfigSchema = z.object({
  contentSync: devContentSyncSchema.optional(),
})

const editorConfigSchema = z.object({
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

export const CanopyConfigSchema = z
  .object({
    media: mediaSchema.optional(),
    // No outer .optional(): both schemas already .default('deny'), so the field is optional on
    // input but always resolves to 'allow'/'deny' (never undefined) on output — an outer
    // .optional() would short-circuit before the inner default runs, defeating the fail-closed
    // default (SCH-M1). defaultPathAccessSchema's .default('deny') sits on the OUTER union, not
    // inside defaultPathAccessLevelsSchema, so an omitted level in the object form stays
    // undefined (resolved to 'deny' at read time by resolveDefaultPathAccess).
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
    // `.optional()`, NOT bare `deploymentNameSchema`: its own `.default('prod')` would make
    // `parse(undefined)` resolve to 'prod' instead of staying `undefined`, collapsing the
    // env > config > modeDefault precedence chain `resolveDeploymentName`
    // (operating-mode/deployment-name.ts) implements — config would always "win" over
    // modeDefault, masking dev's real default of 'local'. Do not remove `.optional()`.
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
// `deploymentName` is ALSO omitted: no caller reads `.deploymentName` off this return value
// (only `services.ts` reads `.remoteName`), and its real default is mode-dependent — 'prod' for
// ProdStrategy, 'local' for DevStrategy (see resolveDeploymentName, used by
// operating-mode/client-unsafe-strategy.ts's getSettingsBranchName) — so this accessor has no
// mode to pick between them. Emitting `deploymentNameSchema.parse(undefined)` ('prod') here
// would silently lie for dev mode.
export const getConfigDefaults = () => ({
  baseBranch: defaultBaseBranchSchema.parse(undefined),
  remoteName: defaultRemoteNameSchema.parse(undefined),
  pathAccess: defaultPathAccessSchema.parse(undefined),
  branchAccess: defaultBranchAccessSchema.parse(undefined),
  contentRoot: contentRootSchema.parse(undefined),
  githubTokenEnvVar: githubTokenEnvVarSchema.parse(undefined),
  prodWorkspace: DEFAULT_PROD_WORKSPACE,
})
