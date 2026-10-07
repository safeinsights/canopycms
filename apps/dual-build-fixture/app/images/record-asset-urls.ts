import { appendFileSync } from 'node:fs'

/**
 * Test-only. When dual-build.test.ts sets FIXTURE_ASSET_URL_LOG, every URL `assetUrl` returns
 * during the build is appended there, through the listener asset-url.ts reads off `globalThis`.
 */
export function installAssetUrlRecorder(): void {
  const log = process.env.FIXTURE_ASSET_URL_LOG
  if (!log) return
  ;(globalThis as Record<symbol, unknown>)[Symbol.for('canopycms.assetUrl.emitted')] = (
    url: string,
  ) => appendFileSync(log, `${url}\n`)
}
