/**
 * Single resolution point for `deploymentName`.
 *
 * `deploymentName` namespaces the settings branch
 * (`canopycms-settings-{deploymentName}`) so two CanopyCMS deployments can
 * share one GitHub repo without both resolving to `canopycms-settings-prod`
 * and fighting over the same orphan branch.
 *
 * Precedence (highest wins):
 *   1. `process.env.CANOPYCMS_DEPLOYMENT_NAME` (trimmed; empty string ignored)
 *   2. `config.deploymentName`
 *   3. `modeDefault` (the caller's mode-specific fallback, e.g. 'prod'/'local')
 *
 * Env wins over config DELIBERATELY. The env var is stamped per-stack by
 * infrastructure (CDK's `CanopyCmsServiceProps.deploymentName` ->
 * `CANOPYCMS_DEPLOYMENT_NAME`), so it is the value GUARANTEED TO DIFFER
 * between two deployments sharing a repo. `config.deploymentName` lives in
 * the shared repo's `canopycms.config.ts`, so it is the value GUARANTEED TO
 * BE IDENTICAL across both deployments (both Lambdas run the same checked-out
 * config). If config won instead, an adopter who already wrote
 * `deploymentName` into their shared config would find the CDK
 * `deploymentName` prop silently doing nothing — exactly the two-stacks-one-repo
 * case this feature exists to fix.
 */

let warned = false

/**
 * Conservative charset for a deployment name. The resolved value is
 * interpolated straight into a git ref (`canopycms-settings-{name}`), and the
 * env var route bypasses the config schema entirely — nothing else validates
 * an infra-stamped value before it becomes a branch name. Rejecting anything
 * outside this set keeps the result a single, well-formed ref component:
 * no `/` (would add a ref hierarchy level and break sanitizeBranchName
 * round-trips), no whitespace, no `..`/`~`/`^`/`:` (git-forbidden), no
 * leading `-` (would parse as a git option).
 *
 * The charset alone is not sufficient: `..`, a trailing `.`, and a `.lock`
 * suffix are all built from allowed characters but are still rejected by
 * git's own ref rules (git-check-ref-format), so they are excluded separately.
 */
const VALID_DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const isValidDeploymentName = (name: string): boolean =>
  VALID_DEPLOYMENT_NAME.test(name) &&
  !name.includes('..') &&
  !name.endsWith('.') &&
  !name.endsWith('.lock')

export function resolveDeploymentName(
  config: { deploymentName?: string },
  modeDefault: string,
): string {
  const envValue = process.env.CANOPYCMS_DEPLOYMENT_NAME?.trim()
  const configValue = config.deploymentName

  if (envValue && configValue && envValue !== configValue && !warned) {
    console.warn(
      `CanopyCMS: CANOPYCMS_DEPLOYMENT_NAME ("${envValue}") differs from config.deploymentName ` +
        `("${configValue}") — using the env var (infra-stamped env wins over shared-repo config ` +
        `by design; see resolveDeploymentName's doc comment). Update config.deploymentName to ` +
        `match if this mismatch was unintentional.`,
    )
    warned = true
  }

  const resolved = envValue || configValue || modeDefault
  if (!isValidDeploymentName(resolved)) {
    const source = envValue
      ? 'CANOPYCMS_DEPLOYMENT_NAME'
      : configValue
        ? 'config.deploymentName'
        : 'the mode default'
    throw new Error(
      `CanopyCMS: invalid deploymentName ${JSON.stringify(resolved)} (from ${source}). ` +
        `It is interpolated into the settings branch name (canopycms-settings-<deploymentName>), ` +
        `so it must start with a letter or digit, contain only letters, digits, '.', '_' or '-', ` +
        `and must not contain '..' or end with '.' or '.lock'.`,
    )
  }
  return resolved
}
