/**
 * Single resolution point for the branch namespace: the prefix every branch the GitHub gateway
 * writes starts with, apart from this deployment's settings branch and the adopter's
 * `legacyBranches` (worker/branch-policy.ts). It comes from a template in which `{deployment}`
 * stands for the deployment name, so two deployments sharing a repository each get their own.
 *
 * Precedence, as for the deployment name and for the same reason: `CANOPYCMS_BRANCH_NAMESPACE`,
 * which infrastructure stamps per stack, then `config.branchNamespace`, then
 * {@link DEFAULT_BRANCH_NAMESPACE_TEMPLATE}. The gateway resolves its own from its own
 * environment, never from anything the CMS Lambda can write.
 */
import { RESERVED_SETTINGS_BRANCH_PREFIX, sanitizeBranchName } from '../paths/branch-name'
import { parseBranchName } from '../paths/validation'
import { canopyLogWarn } from '../utils/logger'
import { resolveDeploymentName } from './deployment-name'

let warned = false
function warnOnce(message: string): void {
  if (warned) return
  warned = true
  canopyLogWarn(message)
}

/** The one placeholder a template may hold. */
const DEPLOYMENT_PLACEHOLDER = '{deployment}'

/** The template used when none is configured. */
export const DEFAULT_BRANCH_NAMESPACE_TEMPLATE = `canopycms/${DEPLOYMENT_PLACEHOLDER}/`

/**
 * The environment variable that carries the template, or the namespace it resolved to.
 * @internal Exported for tests.
 */
export const BRANCH_NAMESPACE_ENV = 'CANOPYCMS_BRANCH_NAMESPACE'

/**
 * Why `namespace` cannot be a branch namespace, or null. It ends with `/`: a deployment name holds
 * no `/`, so `canopycms/prod/` never starts `canopycms/prod-eu/`, as `canopycms-prod-` would start
 * `canopycms-prod-eu-`. A branch in it must be a name git and the gateway take (checked with a
 * branch appended), and none may be a settings branch, by name or by workspace directory.
 */
export function branchNamespaceProblem(namespace: string): string | null {
  if (!namespace.endsWith('/')) return 'it must end with "/"'
  const sample = `${namespace}x`
  if (!/^[\x21-\x7e]+$/.test(namespace)) return 'it is not printable ASCII without spaces'
  if (/["%{}]/.test(namespace)) return 'it contains ", %, { or }'
  if (/^(?:refs|heads|tags|remotes)\//i.test(namespace)) {
    return "it starts with 'refs/', 'heads/', 'tags/' or 'remotes/'"
  }
  const parsed = parseBranchName(sample)
  if (!parsed.ok) return `a branch in it would be refused (${parsed.error})`
  if (sample.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return "a part of it starts with '.' or ends with '.lock'"
  }
  // A branch's directory is the namespace's own sanitized form followed by the rest, so a
  // namespace that sanitizes to a start of the settings prefix (`canopycms/`) holds settings names.
  const directoryPrefix = sanitizeBranchName(namespace)
  if (
    RESERVED_SETTINGS_BRANCH_PREFIX.startsWith(directoryPrefix) ||
    sanitizeBranchName(sample).startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)
  ) {
    return `some branches in it would be ${RESERVED_SETTINGS_BRANCH_PREFIX}* settings branches`
  }
  return null
}

/**
 * The namespace `template` names for `deploymentName`, or why it cannot be one. Throws, naming
 * `source`, for a template with a placeholder other than `{deployment}` or a namespace
 * {@link branchNamespaceProblem} refuses.
 */
export function resolveBranchNamespaceTemplate(
  template: string,
  deploymentName: string,
  source: string,
): string {
  const unknown = template.replaceAll(DEPLOYMENT_PLACEHOLDER, '').match(/\{[^}]*\}?/)
  if (unknown) {
    throw new Error(
      `CanopyCMS: invalid branch namespace ${JSON.stringify(template)} (from ${source}): ` +
        `${JSON.stringify(unknown[0])} is not a placeholder; the only one is ${DEPLOYMENT_PLACEHOLDER}`,
    )
  }
  const namespace = template.replaceAll(DEPLOYMENT_PLACEHOLDER, deploymentName)
  const problem = branchNamespaceProblem(namespace)
  if (problem !== null) {
    throw new Error(
      `CanopyCMS: invalid branch namespace ${JSON.stringify(namespace)} (from ${source}): ${problem}`,
    )
  }
  return namespace
}

/**
 * The branch namespace a process resolves: from `env`'s `CANOPYCMS_BRANCH_NAMESPACE` (trimmed,
 * empty ignored), then `config.branchNamespace`, then the default, with `{deployment}` filled by
 * `resolveDeploymentName`. Throws for an invalid template or deployment name.
 */
export function resolveBranchNamespace(
  config: { branchNamespace?: string; deploymentName?: string },
  modeDefault: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromEnv = env[BRANCH_NAMESPACE_ENV]?.trim()
  const [template, source] = fromEnv
    ? [fromEnv, BRANCH_NAMESPACE_ENV]
    : config.branchNamespace !== undefined
      ? [config.branchNamespace, 'config.branchNamespace']
      : [DEFAULT_BRANCH_NAMESPACE_TEMPLATE, 'the default']
  const deploymentName = resolveDeploymentName(
    { deploymentName: config.deploymentName },
    modeDefault,
  )
  const namespace = resolveBranchNamespaceTemplate(template, deploymentName, source)
  // Compared resolved: infrastructure stamps the namespace, config holds the template.
  if (fromEnv && config.branchNamespace !== undefined) {
    let fromConfig: string | null = null
    try {
      fromConfig = resolveBranchNamespaceTemplate(
        config.branchNamespace,
        deploymentName,
        'config.branchNamespace',
      )
    } catch {
      // An invalid config template is warned about too: the environment variable wins anyway.
    }
    if (fromConfig !== namespace) {
      warnOnce(
        `CanopyCMS: ${BRANCH_NAMESPACE_ENV} (${JSON.stringify(fromEnv)}) and ` +
          `config.branchNamespace (${JSON.stringify(config.branchNamespace)}) do not resolve to ` +
          'the same valid namespace; using the environment variable, which infrastructure stamps ' +
          'per stack.',
      )
    }
  }
  return namespace
}
