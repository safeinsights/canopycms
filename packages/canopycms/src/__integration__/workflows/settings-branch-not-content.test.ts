/**
 * The settings branch through the generic `/:branch` routes, against real git and the
 * handler's own default getBranchContext (no override, unlike createApiClient). A content
 * workspace under the settings name carries content history, and a submit would push it to
 * the remote, where settings provisioning checks it out with no groups or path rules.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'
import { simpleGit } from 'simple-git'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createCanopyRequestHandler } from '../../http/handler'
import type { CanopyRequest } from '../../http/types'
import { createTestServices } from '../../config-test'
import { operatingStrategy } from '../../operating-mode'

const request = (method: string, segments: string[]): CanopyRequest => ({
  method,
  url: `http://localhost/api/canopycms/${segments.join('/')}`,
  header: () => null,
  json: async () => ({}),
})

describe('the settings branch through the content routes', () => {
  let workspace: TestWorkspace

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('is not found for an editor, and nothing reaches the workspace or the remote', async () => {
    workspace = await createTestWorkspace()
    const services = await createTestServices({ ...workspace.config, schema: { collections: [] } })
    const handler = createCanopyRequestHandler({
      services,
      authPlugin: createMockAuthPlugin('editor'),
    })
    const strategy = operatingStrategy('dev')
    const settingsBranch = strategy.getSettingsBranchName(workspace.config)

    const status = await handler(request('GET', [settingsBranch, 'status']), [
      settingsBranch,
      'status',
    ])
    const submit = await handler(request('POST', [settingsBranch, 'submit']), [
      settingsBranch,
      'submit',
    ])

    expect(status.status).toBe(404)
    expect(submit.status).toBe(404)
    const contentBranches = path.join(workspace.tmpRoot, '.canopy-dev', 'content-branches')
    expect(await fs.readdir(contentBranches)).not.toContain(settingsBranch)
    const remoteHeads = await simpleGit({ baseDir: workspace.remotePath }).raw([
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads',
    ])
    expect(remoteHeads.trim().split('\n')).toEqual(['refs/heads/main'])
    // The request did provision the settings workspace, as every request does: still its
    // empty orphan.
    const settingsLog = await simpleGit({ baseDir: strategy.getSettingsRoot() }).raw([
      'log',
      '--format=%s',
    ])
    expect(settingsLog.trim()).toBe('Initialize settings branch')
  }, 60_000)
})
