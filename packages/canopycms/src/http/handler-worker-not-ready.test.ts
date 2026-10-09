/**
 * The not-ready 503 driven through real prod provisioning, with no remote.git in the workspace:
 * the typed error reaches the handler's catch through every layer it crosses in production, so a
 * layer that wraps it fails here rather than passing a test that injects it.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AuthPlugin } from '../auth/plugin'
import { defineCanopyTestConfig } from '../config-test'
import { clearStrategyCache } from '../operating-mode/client-unsafe-strategy'
import { writeWorkerStatus } from '../task-queue/worker-status'
import { mockConsole, type MockConsole } from '../test-utils'
import { createCanopyRequestHandlerFromConfig } from './handler'
import { WORKER_NOT_READY_MESSAGE } from './worker-not-ready'

const authPlugin: AuthPlugin = {
  verifiesCredentials: true,
  authenticate: async () => ({ success: true, user: { userId: 'editor-1', externalGroups: [] } }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
}

describe('the not-ready 503 under real prod provisioning', () => {
  let workspaceRoot: string
  let previousRoot: string | undefined
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-not-ready-'))
    previousRoot = process.env.CANOPYCMS_WORKSPACE_ROOT
    process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot
    clearStrategyCache()
  })

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.CANOPYCMS_WORKSPACE_ROOT
    else process.env.CANOPYCMS_WORKSPACE_ROOT = previousRoot
    clearStrategyCache()
    consoleSpy.restore()
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  const getBranches = async () => {
    const handler = await createCanopyRequestHandlerFromConfig({
      config: defineCanopyTestConfig({ schema: [], mode: 'prod' }),
      authPlugin,
    })
    return handler(
      {
        method: 'GET',
        url: 'http://localhost/api/canopycms/branches',
        header: () => null,
        json: async () => undefined,
      },
      ['branches'],
    )
  }

  const recordStatus = (startedAt: string, fatalAt: string) =>
    writeWorkerStatus(path.join(workspaceRoot, '.tasks'), {
      version: 1,
      startedAt,
      updatedAt: fatalAt,
      lastFatalError: {
        message:
          'Secret arn:aws:secretsmanager:us-east-1:123456789012:secret:bot-token has no field "token".',
        at: fatalAt,
        phase: 'startup',
      },
    })

  it('asks the caller to retry while the worker has recorded nothing', async () => {
    const response = await getBranches()

    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBe('30')
    expect(response.body).toMatchObject({ ok: false, error: WORKER_NOT_READY_MESSAGE })
  })

  it("names the worker's failed start, with no Retry-After and the account id masked", async () => {
    await recordStatus('2026-10-09T10:00:00.000Z', '2026-10-09T10:00:02.000Z')

    const response = await getBranches()

    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBeUndefined()
    expect(response.body).toMatchObject({ ok: false, code: 'WORKER_FAILED' })
    const { error } = response.body as { error: string }
    expect(error).toContain('The CMS worker failed to start')
    expect(error).toContain(
      'arn:aws:secretsmanager:us-east-1:************:secret:bot-token has no field "token".',
    )
    expect(error).not.toMatch(/[0-9]{12}/)
  })

  it('stays retriable while a newer worker starts again after the failure', async () => {
    await recordStatus('2026-10-09T10:05:00.000Z', '2026-10-09T10:00:02.000Z')

    const response = await getBranches()

    expect(response.status).toBe(503)
    expect(response.headers?.['Retry-After']).toBe('30')
    const { error } = response.body as { error: string }
    expect(error).toContain('starting again after a failure')
    expect(error).toContain('has no field "token"')
  })

  it('is no longer "not ready" when remote.git is not a directory', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'remote.git'), 'not a repository')

    const response = await getBranches()

    expect(response.headers?.['Retry-After']).toBeUndefined()
    const { error } = response.body as { error: string }
    expect(error).not.toBe(WORKER_NOT_READY_MESSAGE)
    expect(error).toContain('is not a directory')
  })
})
