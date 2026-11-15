import { NextResponse } from 'next/server'
import path from 'node:path'
import { createLocalWorker } from 'canopycms/worker/cms-worker'

/**
 * Test-only endpoint that runs the worker's sync of every branch on demand, through the same
 * GitHub-less worker dev's "Get latest changes" runs. Used by e2e tests to simulate the worker
 * detecting upstream conflicts.
 *
 * POST /api/e2e-test/rebase
 */
export async function POST() {
  // Available in next dev always (unchanged), and under a production-mode
  // server ONLY when the e2e harness marks the process (playwright.config's
  // webServer sets CANOPY_E2E=1 — e2e runs `next build && next start` on CI
  // for realistic, faster serving). A real production deployment never sets
  // CANOPY_E2E, so this stays unreachable there.
  const allowed = process.env.CANOPY_E2E === '1' || process.env.NODE_ENV === 'development'
  if (!allowed) {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 })
  }

  const workspacePath = path.resolve(process.cwd(), '.canopy-dev')

  await createLocalWorker({
    workspacePath,
    baseBranch: 'main',
    contentRoot: 'content',
  }).syncBranchesNow()

  return NextResponse.json({ ok: true })
}
