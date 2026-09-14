/**
 * Single resolution point for the operating `mode`: the environment value for
 * the current runtime wins (see `readModeEnv`), else `config.mode`.
 *
 * One `canopycms.config.ts` (where `mode` is required, SEC-C1) is loaded by
 * `next dev`, by `next build` in the image builder and by the deployed Lambda,
 * and those three need different answers, so only a RUN-time value works:
 *   - `next dev` and `next build` are both `dev`. Build-time reads come from
 *     the working tree in either mode (`readsFromCheckout` in build-mode.ts),
 *     while prod would hold the image builder to checks it has no reason to
 *     meet: `gitBotAuthorName`/`gitBotAuthorEmail` (the prod strategy's
 *     `validateConfig`) and a credential-verifying auth plugin
 *     (`assertAuthPluginAllowedForMode`). See Dockerfile.cms.template.
 *   - The Lambda is `prod`: dev resolves the workspace to `<cwd>/.canopy-dev`,
 *     and Lambda's filesystem is read-only outside /tmp, so the first write
 *     fails with EROFS.
 *
 * Two variable names, on purpose. Server code reads `CANOPY_MODE`, stamped on
 * the Lambda by `CanopyCmsService` and deliberately NOT set during
 * `next build`. Browser code has no runtime environment — the editor page
 * imports the config directly (`config.client()`), so its `mode` is whatever
 * was inlined at build time, and Next inlines only `NEXT_PUBLIC_*`. Both names
 * MUST appear as literal `process.env.X` member expressions here or the
 * bundler cannot substitute them.
 *
 * An unrecognized value throws rather than falling back: falling back would
 * turn a typo (`CANOPY_MODE=production`) into a silent dev-mode deployment
 * running header-trusting dev auth semantics.
 */

import { canopyLogWarn } from '../utils/logger'
import type { OperatingMode } from './types'

export const SERVER_MODE_ENV_VAR = 'CANOPY_MODE'
export const BROWSER_MODE_ENV_VAR = 'NEXT_PUBLIC_CANOPY_MODE'

let warned = false

/** Reset the once-per-process warning latch. Test-only. */
export function resetModeWarning(): void {
  warned = false
}

/**
 * Guarded with `typeof process` because a non-Next bundler may leave no
 * `process` shim in the browser; the member expressions stay literal so Next's
 * DefinePlugin substitution still applies.
 */
function readModeEnv(): { name: string; value: string } | undefined {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') return undefined
  const inBrowser = typeof window !== 'undefined'
  const name = inBrowser ? BROWSER_MODE_ENV_VAR : SERVER_MODE_ENV_VAR
  const raw = inBrowser ? process.env.NEXT_PUBLIC_CANOPY_MODE : process.env.CANOPY_MODE
  const value = raw?.trim()
  return value ? { name, value } : undefined
}

/**
 * Called from `validateCanopyConfig`, the one point every config-authoring path
 * (`defineCanopyConfig`, `composeCanopyConfig`) funnels through.
 */
export function resolveOperatingMode(configMode: OperatingMode): OperatingMode {
  const env = readModeEnv()
  if (!env) return configMode

  if (env.value !== 'prod' && env.value !== 'dev') {
    throw new Error(
      `CanopyCMS: invalid ${env.name}=${JSON.stringify(env.value)}. ` +
        `It must be exactly "prod" or "dev". Refusing to fall back to the configured mode ` +
        `(${JSON.stringify(configMode)}): a typo here would silently deploy dev auth semantics.`,
    )
  }

  if (env.value !== configMode && !warned) {
    // canopyLogWarn, not console.warn: shared modules can run inside the worker
    // daemon, where an unprefixed line is folded into the previous CloudWatch
    // event (utils/logger.ts).
    canopyLogWarn(
      `CanopyCMS: ${env.name}="${env.value}" overrides config.mode="${configMode}". ` +
        `The environment wins by design — it is the per-deployment value, while ` +
        `canopycms.config.ts is shared by local dev, the image build and the deployment. ` +
        `See operating-mode/mode-env.ts.`,
    )
    warned = true
  }

  return env.value
}
