/**
 * Single resolution point for the operating `mode`.
 *
 * `mode` is required in `canopycms.config.ts` (SEC-C1) and that file lives in
 * the adopter's repo — the SAME file is loaded by `next dev` locally, by
 * `next build` inside the image builder, and by the deployed Lambda. Those
 * three want different answers, so a literal in the config file cannot be
 * right for all of them:
 *
 *   - `next dev` must be `dev` (workspace at `<cwd>/.canopy-dev`).
 *   - `next build` must be `dev` too: prod-mode build reads would try to open
 *     a branch workspace on EFS that cannot exist in an image builder (see
 *     the note in `cli/template-files/Dockerfile.cms.template`).
 *   - The deployed Lambda must be `prod`: dev mode resolves the workspace to
 *     `<cwd>/.canopy-dev`, and Lambda's filesystem is read-only outside /tmp,
 *     so the first write fails with EROFS.
 *
 * Only a value resolved at RUN time can satisfy all three, which is why this
 * is an environment override rather than a flag baked into the generated
 * config file. `CANOPY_MODE` is the name the deployment templates already
 * referred to; before this module existed nothing read it.
 *
 * Precedence (highest wins):
 *   1. the environment value for the current runtime (see `readModeEnv`)
 *   2. `config.mode` (the literal in `canopycms.config.ts`)
 *
 * ## Two variable names, on purpose
 *
 * Server code reads `CANOPY_MODE`, which the CDK construct stamps onto the
 * Lambda (`CanopyCmsService` sets `CANOPY_MODE=prod`). It is deliberately NOT
 * set during `next build`, so build-time content reads stay in dev mode.
 *
 * Browser code cannot read a runtime environment at all — the editor page
 * imports `canopycms.config.ts` directly (`config.client()`), so the browser's
 * copy of `mode` is whatever was inlined when the bundle was built. Next.js
 * only inlines `NEXT_PUBLIC_*`, so the browser reads
 * `NEXT_PUBLIC_CANOPY_MODE`, which the generated CDK stack passes as a Docker
 * build arg. Both names must be spelled as literal `process.env.X` member
 * expressions here or the bundler cannot substitute them.
 *
 * An unrecognized value throws rather than falling back. Falling back would
 * turn a typo (`CANOPY_MODE=production`) into a silent dev-mode deployment
 * running header-trusting dev auth semantics — the exact failure SEC-C1 made
 * `mode` required to prevent.
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
 * The environment value for the current runtime, or undefined when unset.
 *
 * Guarded with `typeof process` because a non-Next bundler may leave no
 * `process` shim in the browser at all; the member expressions themselves stay
 * literal so Next's DefinePlugin substitution still applies.
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
 * Resolve the effective operating mode from the environment and the config
 * literal. Called from `validateCanopyConfig`, the one point every documented
 * config-authoring path (`defineCanopyConfig`, `composeCanopyConfig`) funnels
 * through.
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
    // canopyLogWarn, not console.warn: shared modules can run inside the
    // worker daemon, where an unprefixed line is folded into the previous
    // CloudWatch event (see utils/logger.ts).
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
