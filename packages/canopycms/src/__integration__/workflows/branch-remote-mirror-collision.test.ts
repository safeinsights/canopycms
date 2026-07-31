/**
 * Integration tests for api/branch.ts's create-time "L2" collision guard: a
 * sanitized-name check against this deployment's local GitHub mirror
 * (`remote.git`), added because the CMS Lambda has no internet access and
 * therefore cannot make a synchronous GitHub API call at branch-create time
 * (see createBranchHandler's doc comment in api/branch.ts). Needs a REAL bare
 * repo (unlike branch.test.ts's mocked unit tests), so these go through the
 * full HTTP API layer against an on-disk `remote.git`.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createMockAuthPlugin } from '../test-utils/multi-user'
import { createApiClient } from '../test-utils/api-client'
import { defineCanopyTestConfig } from '../../config-test'
import { initTestRepo } from '../../test-utils'
import { GITHUB_TRACKING_REF_PREFIX } from '../../git-manager'
import type { BranchResponse } from '../../api/branch'

describe('Branch creation: remote-mirror collision guard (L2)', () => {
  describe('with a real remote.git configured', () => {
    let workspace: TestWorkspace
    let client: Awaited<ReturnType<typeof createApiClient>>

    beforeEach(async () => {
      workspace = await createTestWorkspace()
      client = await createApiClient({
        config: workspace.config,
        authPlugin: createMockAuthPlugin('editor'),
      })
    })

    afterEach(async () => {
      await workspace.cleanup()
    })

    it("does NOT reject a name present only in the mirror's refs/heads/* namespace", async () => {
      // refs/heads/* in remote.git is this deployment's own local origin, and
      // nothing ever removes a ref from it: deleting a branch in the editor
      // unlinks its metadata and rm -rf's the clone, and the worker's
      // reconcile deliberately never deletes a local head. Treating a local
      // head as a collision would therefore make the ordinary
      // create -> publish -> merge -> delete -> reuse-the-name cycle fail
      // permanently on a name the user had just deleted. Branches that are
      // genuinely still live for THIS deployment are caught by the branch
      // registry check that runs before this one.
      await simpleGit({ baseDir: workspace.seedPath }).raw([
        'push',
        'origin',
        'main:refs/heads/local-leftover',
      ])

      const res = await client.post('/api/canopycms/branches', { branch: 'local-leftover' })
      expect(res.status).toBe(200)
    })

    it('rejects (409) a name present ONLY under the GitHub tracking namespace (two-deployments-one-repo case)', async () => {
      // Models a branch that another CanopyCMS deployment sharing this
      // GitHub repo pushed (or a direct push straight to GitHub): syncGit()
      // fetches GitHub into this namespace, and reconcileTrackedBranches()
      // may not yet have promoted it into a local head -- refs/heads/*
      // alone would miss it.
      await simpleGit({ baseDir: workspace.seedPath }).raw([
        'push',
        'origin',
        `main:${GITHUB_TRACKING_REF_PREFIX}tracked-only-branch`,
      ])

      const res = await client.post('/api/canopycms/branches', { branch: 'tracked-only-branch' })
      expect(res.status).toBe(409)
      const body = await res.json<BranchResponse>()
      expect(body.error).toMatch(/already exists on the remote/)
    })

    it('proceeds (200) when the requested name is absent from both namespaces', async () => {
      const res = await client.post('/api/canopycms/branches', { branch: 'brand-new-branch' })
      expect(res.status).toBe(200)
      const body = await res.json<BranchResponse>()
      expect(body.data?.branch.name).toBe('brand-new-branch')
    })
  })

  describe('with no remote.git resolvable (dev mode, no defaultRemoteUrl/env configured)', () => {
    let tmpRoot: string
    let cwdSpy: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
      // A from-scratch dev-mode checkout: a real git repo with a commit on
      // main, but deliberately no defaultRemoteUrl/CANOPYCMS_REMOTE_URL --
      // i.e. exactly what an adopter's fresh local dev environment looks
      // like before any remote has ever been configured or auto-created.
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-no-remote-test-'))
      const git = await initTestRepo(tmpRoot)
      await git.raw(['branch', '-M', 'main'])
      await fs.mkdir(path.join(tmpRoot, 'content'), { recursive: true })
      await fs.writeFile(path.join(tmpRoot, 'README.md'), '# Test\n', 'utf8')
      await git.add(['.'])
      await git.commit('initial commit')

      // Mock cwd so dev-mode's git-root/auto-init logic (GitManager.findGitRoot,
      // ensureLocalSimulatedRemote) stays inside this scratch repo instead of
      // touching the real checkout running these tests.
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)
    })

    afterEach(async () => {
      cwdSpy.mockRestore()
      await fs.rm(tmpRoot, { recursive: true, force: true })
    })

    it('skips the check and lets creation proceed without throwing', async () => {
      // DevStrategy.getRemoteUrlConfig() has no autoDetectRemotePath (only
      // ProdStrategy does -- see operating-mode/client-unsafe-strategy.ts),
      // and neither config.defaultRemoteUrl nor CANOPYCMS_REMOTE_URL is set
      // here, so the guard's read-only resolution chain finds nothing and
      // must skip (logging a warning) rather than throwing or blocking.
      // Real branch creation still succeeds end-to-end: the ACTUAL clone
      // (GitManager.initializeWorkspace, via the full resolveRemoteUrl) self
      // -heals via dev mode's auto-init, exactly as it would for a developer
      // running locally for the first time with no remote configured yet.
      const config = defineCanopyTestConfig({
        mode: 'dev',
        defaultBranchAccess: 'allow',
        defaultPathAccess: 'allow',
        defaultBaseBranch: 'main',
        defaultRemoteName: 'origin',
        schema: { collections: [] },
      })

      const client = await createApiClient({
        config,
        authPlugin: createMockAuthPlugin('editor'),
      })

      // A throw/rejection here (from our guard OR anything downstream) would
      // fail this await outright -- there is no try/catch masking it.
      const res = await client.post('/api/canopycms/branches', { branch: 'no-remote-branch' })
      expect(res.status).toBe(200)
      const body = await res.json<BranchResponse>()
      expect(body.data?.branch.name).toBe('no-remote-branch')
    })
  })
})
