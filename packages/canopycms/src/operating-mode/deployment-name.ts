/**
 * Single resolution point for `deploymentName`, which namespaces the settings
 * branch (`canopycms-settings-{deploymentName}`) so two CanopyCMS deployments
 * can share one GitHub repo without fighting over the same orphan branch.
 *
 * Precedence: `process.env.CANOPYCMS_DEPLOYMENT_NAME` (trimmed, empty ignored),
 * then `config.deploymentName`, then `modeDefault` (the caller's mode-specific
 * fallback, e.g. 'prod'/'local').
 *
 * Env wins over config DELIBERATELY. Infrastructure stamps the env var
 * per-stack (CDK's `CanopyCmsServiceProps.deploymentName`), so it is the value
 * GUARANTEED TO DIFFER between two deployments sharing a repo, while
 * `config.deploymentName` lives in the shared repo's `canopycms.config.ts` and
 * is GUARANTEED TO BE IDENTICAL across both. If config won, an adopter who had
 * already written `deploymentName` into their shared config would find the CDK
 * prop silently doing nothing — the two-stacks-one-repo case this exists to fix.
 */

import { canopyLogWarn } from '../utils/logger'

let warned = false

/**
 * Conservative charset for a deployment name. The resolved value is
 * interpolated straight into a git ref (`canopycms-settings-{name}`), and the
 * env var route bypasses the config schema entirely — nothing else validates an
 * infra-stamped value before it becomes a branch name. So the result must stay
 * a single well-formed ref component: no `/` (would add a ref hierarchy level
 * and break sanitizeBranchName round-trips), no whitespace, no `..`/`~`/`^`/`:`
 * (git-forbidden), no leading `-` (would parse as a git option). `..`, a
 * trailing `.` and a `.lock` suffix are built from allowed characters but are
 * still rejected by git-check-ref-format, so they are excluded separately below.
 */
const VALID_DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Exported so `canopycms-cdk`'s suite can assert that its own synth-time copy of
 * this rule (constructs/cms-service.ts) still agrees with this one. The
 * construct deliberately does not import this directly — see its own
 * `isValidDeploymentName` doc comment. The drift check is therefore test-only,
 * over `deployment-name-fixtures.ts`.
 */
export const isValidDeploymentName = (name: string): boolean =>
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
    // canopyLogWarn, not console.warn: cms-worker.ts resolves through this
    // inside start(), so the line lands in worker.log, where an unprefixed line
    // is folded into the previous CloudWatch event (utils/logger.ts).
    canopyLogWarn(
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
