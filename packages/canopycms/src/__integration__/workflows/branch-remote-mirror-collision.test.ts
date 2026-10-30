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
import { branchRef } from '../test-utils/branch-names'
import { defineCanopyTestConfig } from '../../config-test'
import { initTestRepo } from '../../test-utils'
import { GITHUB_TRACKING_REF_PREFIX } from '../../git-manager'
import type { BranchListItemResponse } from '../../api/branch'

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
        `main:refs/heads/${branchRef('leftover')}`,
      ])

      const res = await client.post('/api/canopycms/branches', {
        branch: 'leftover',
      })
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
        `main:${GITHUB_TRACKING_REF_PREFIX}${branchRef('tracked-only-branch')}`,
      ])

      // The collision is on the ref the create makes: the typed name under the namespace.
      const res = await client.post('/api/canopycms/branches', { branch: 'tracked-only-branch' })
      expect(res.status).toBe(409)
      const body = await res.json<BranchListItemResponse>()
      expect(body.error).toMatch(/already exists on the remote/)
      expect(body.code).toBe('BRANCH_NAME_REFUSED')
    })

    it.each([
      ['a local head', 'refs/heads/'],
      ['a GitHub tracking ref', GITHUB_TRACKING_REF_PREFIX],
    ])(
      'refuses (409) every create while %s is named after part of the namespace',
      async (_label, prefix) => {
        for (const ancestor of ['canopycms', 'canopycms/local']) {
          const ref = `${prefix}${ancestor}`
          await simpleGit({ baseDir: workspace.seedPath }).raw(['push', 'origin', `main:${ref}`])

          const res = await client.post('/api/canopycms/branches', { branch: 'spring' })
          expect(res.status).toBe(409)
          const body = await res.json<BranchListItemResponse>()
          expect(body.error).toContain(`a branch named "${ancestor}" exists on the remote`)
          expect(body.code).toBeUndefined()

          await simpleGit({ baseDir: workspace.seedPath }).raw(['push', 'origin', `:${ref}`])
        }
        const res = await client.post('/api/canopycms/branches', { branch: 'spring' })
        expect(res.status).toBe(200)
      },
    )

    it.each([
      ['a local head', 'refs/heads/'],
      ['a GitHub tracking ref', GITHUB_TRACKING_REF_PREFIX],
    ])('refuses (409) a create while %s sits inside the new branch', async (_label, prefix) => {
      const ref = `${prefix}${branchRef('spring')}/draft`
      await simpleGit({ baseDir: workspace.seedPath }).raw(['push', 'origin', `main:${ref}`])

      const res = await client.post('/api/canopycms/branches', { branch: 'spring' })
      expect(res.status).toBe(409)
      const body = await res.json<BranchListItemResponse>()
      expect(body.error).toBe(
        `"spring" cannot be created: the remote has a branch named "${branchRef('spring')}/draft" ` +
          'inside it, and git cannot hold both. Choose a different name.',
      )
      expect(body.code).toBe('BRANCH_NAME_REFUSED')

      await simpleGit({ baseDir: workspace.seedPath }).raw(['push', 'origin', `:${ref}`])
      expect((await client.post('/api/canopycms/branches', { branch: 'spring' })).status).toBe(200)
    })

    it('creates a branch beside one whose name merely starts with it', async () => {
      await simpleGit({ baseDir: workspace.seedPath }).raw([
        'push',
        'origin',
        `main:${GITHUB_TRACKING_REF_PREFIX}${branchRef('spring')}-draft`,
      ])

      expect((await client.post('/api/canopycms/branches', { branch: 'spring' })).status).toBe(200)
    })

    it('proceeds (200) when the requested name is absent from both namespaces', async () => {
      const res = await client.post('/api/canopycms/branches', {
        branch: 'brand-new-branch',
      })
      expect(res.status).toBe(200)
      const body = await res.json<BranchListItemResponse>()
      expect(body.data?.branch.name).toBe(branchRef('brand-new-branch'))
    })

    it('creating a branch heals an ORPHANED stale head (present in refs/heads/* only, no tracking ref, no registry entry)', async () => {
      // The ordering deleteBranchHandler's own cleanup cannot cover: branch
      // deleted in the CMS while it still existed on GitHub -> the sync
      // loop's reconcile re-created the local head from the tracking ref ->
      // GitHub side later deleted -> --prune dropped the tracking ref ->
      // the re-created head is orphaned with no registry entry left for the
      // delete path to ever run against. Reuse-time healing in
      // createBranchHandler is what closes this: once the registry and
      // tracking checks both pass, a remaining local head is stale by
      // definition and must not survive to reject the new branch's first
      // publish.
      await simpleGit({ baseDir: workspace.seedPath }).raw([
        'push',
        'origin',
        `main:refs/heads/${branchRef('orphaned-head')}`,
      ])

      const res = await client.post('/api/canopycms/branches', {
        branch: 'orphaned-head',
      })
      expect(res.status).toBe(200)

      const mirrorRefs = await simpleGit({
        baseDir: workspace.remotePath,
        config: ['safe.bareRepository=all'],
      }).raw(['for-each-ref', '--format=%(refname)', 'refs/heads/'])
      expect(mirrorRefs).not.toContain(`refs/heads/${branchRef('orphaned-head')}`)
    })

    it('deleting a branch removes its stale head from the mirror but preserves the tracking ref, so the name is cleanly reusable', async () => {
      // The other half of the local-leftover story above: refs/heads/* in
      // remote.git is only safe to IGNORE at create time because the delete
      // path now REMOVES it. If it didn't, the reused name's first publish
      // would be rejected non-fast-forward against the stale old tip (a
      // squash-merged branch's tip is not an ancestor of a fresh branch off
      // base) -- a permanent, misleading 409 on a name the user just deleted.
      // safe.bareRepository=all: sandboxed/CI git setups can set
      // safe.bareRepository=explicit, which refuses cwd-based discovery of
      // bare repos (same reason bareRemoteHasBranch uses --git-dir).
      const reusedRef = branchRef('reused-name')
      const mirrorGit = simpleGit({
        baseDir: workspace.remotePath,
        config: ['safe.bareRepository=all'],
      })

      const created = await client.post('/api/canopycms/branches', {
        branch: 'reused-name',
      })
      expect(created.status).toBe(200)

      // Simulate the branch having been published (its head exists in the
      // mirror at a tip that is NOT an ancestor of base, like a squash-merged
      // branch) and still present in GitHub's view (tracking ref).
      const seedGit = simpleGit({ baseDir: workspace.seedPath })
      await seedGit.raw(['checkout', '-b', reusedRef])
      await fs.writeFile(path.join(workspace.seedPath, 'divergent.md'), 'old branch tip\n', 'utf8')
      await seedGit.add(['divergent.md'])
      await seedGit.commit('old branch tip')
      await seedGit.raw(['push', 'origin', `${reusedRef}:refs/heads/${reusedRef}`])
      await seedGit.raw([
        'push',
        'origin',
        `${reusedRef}:${GITHUB_TRACKING_REF_PREFIX}${reusedRef}`,
      ])
      await seedGit.raw(['checkout', 'main'])

      const deleted = await client.delete('/api/canopycms/reused-name')
      expect(deleted.status).toBe(200)

      const refs = (await mirrorGit.raw(['for-each-ref', '--format=%(refname)', 'refs/'])).split(
        '\n',
      )
      expect(refs).not.toContain(`refs/heads/${reusedRef}`)
      // GitHub's view is NOT ours to erase: while the branch still exists on
      // GitHub, the create-time check below must keep matching it.
      expect(refs).toContain(`${GITHUB_TRACKING_REF_PREFIX}${reusedRef}`)

      // And with the tracking ref still present, an immediate recreate is
      // correctly refused as a remote collision (the honest, actionable
      // outcome) rather than accepted and later failing at publish time.
      const recreate = await client.post('/api/canopycms/branches', {
        branch: 'reused-name',
      })
      expect(recreate.status).toBe(409)

      // Once GitHub's side is gone too (branch deleted there; syncGit's
      // --prune drops the tracking ref), the name is fully reusable.
      await mirrorGit.raw(['update-ref', '-d', `${GITHUB_TRACKING_REF_PREFIX}${reusedRef}`])
      const recreateAfterPrune = await client.post('/api/canopycms/branches', {
        branch: 'reused-name',
      })
      expect(recreateAfterPrune.status).toBe(200)
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
      const res = await client.post('/api/canopycms/branches', {
        branch: 'no-remote-branch',
      })
      expect(res.status).toBe(200)
      const body = await res.json<BranchListItemResponse>()
      expect(body.data?.branch.name).toBe(branchRef('no-remote-branch'))
    })
  })
})
