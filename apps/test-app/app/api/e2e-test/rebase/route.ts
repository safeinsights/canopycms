import { NextResponse } from 'next/server'
import path from 'node:path'
import { CmsWorker } from 'canopycms/worker/cms-worker'

/**
 * Test-only endpoint that triggers rebaseActiveBranches() on demand.
 * Used by e2e tests to simulate the worker detecting upstream conflicts.
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

  const worker = new CmsWorker({
    workspacePath,
    githubOwner: 'test',
    githubRepo: 'test',
    githubToken: 'fake-token',
    baseBranch: 'main',
    contentRoot: 'content',
  })

  // Same pattern as unit tests — cast to access private method
  await (worker as unknown as { rebaseActiveBranches(): Promise<void> }).rebaseActiveBranches()

  return NextResponse.json({ ok: true })
}
