import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { scanBranchHealth } from './branch-health'
import { getBranchMetadataFileManager } from './branch-metadata'
import { generateId } from './id'
import { mockConsole } from './test-utils/console-spy'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branch-health-'))

/** Create a healthy branch directory with a valid branch.json (via the real save() path). */
const createHealthyBranch = async (root: string, branchName: string) => {
  const branchDir = path.join(root, branchName)
  await fs.mkdir(branchDir, { recursive: true })
  const manager = getBranchMetadataFileManager(branchDir, root, { settleMs: 0 })
  await manager.save({ branch: { name: branchName, status: 'editing', createdBy: 'user-1' } })
}

/** Create a branch directory whose branch.json is present but not valid JSON. */
const createCorruptBranch = async (root: string, dirName: string) => {
  const metaDir = path.join(root, dirName, '.canopy-meta')
  await fs.mkdir(metaDir, { recursive: true })
  await fs.writeFile(path.join(metaDir, 'branch.json'), 'not json {{{', 'utf-8')
}

/** Create an orphan branch directory: no .canopy-meta/branch.json at all. */
const createOrphanBranch = async (
  root: string,
  dirName: string,
  opts?: { withGitDir?: boolean },
) => {
  const branchDir = path.join(root, dirName)
  await fs.mkdir(branchDir, { recursive: true })
  if (opts?.withGitDir) {
    await fs.mkdir(path.join(branchDir, '.git'), { recursive: true })
  }
}

/** The exact on-disk path branch-workspace.ts's ensureGitWorkspace() locks. */
const initLockPath = (root: string, dirName: string) => path.join(root, `.${dirName}.init.lock`)

const createInitLock = async (root: string, dirName: string, ageMs = 0) => {
  const lockPath = initLockPath(root, dirName)
  await fs.mkdir(lockPath, { recursive: true })
  if (ageMs > 0) {
    const staleTime = new Date(Date.now() - ageMs)
    await fs.utimes(lockPath, staleTime, staleTime)
  }
}

describe('scanBranchHealth', () => {
  it('returns [] when baseRoot does not exist', async () => {
    const root = await tmpDir()
    const result = await scanBranchHealth(path.join(root, 'nope'), { baseBranchName: 'main' })
    expect(result).toEqual([])
  })

  it('classifies healthy branches, marking isBaseBranch for the base branch only', async () => {
    const root = await tmpDir()
    await createHealthyBranch(root, 'main')
    await createHealthyBranch(root, 'feature-x')

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries).toHaveLength(2)

    const main = entries.find((e) => e.dirName === 'main')
    const feature = entries.find((e) => e.dirName === 'feature-x')

    expect(main?.kind).toBe('healthy')
    expect(main?.isBaseBranch).toBe(true)
    expect(main?.branch?.name).toBe('main')

    expect(feature?.kind).toBe('healthy')
    expect(feature?.isBaseBranch).toBeUndefined()
    expect(feature?.branch?.name).toBe('feature-x')
  })

  it('omits duplicateContentIds for a healthy branch with no duplicates', async () => {
    const root = await tmpDir()
    await createHealthyBranch(root, 'clean-branch')
    await fs.mkdir(path.join(root, 'clean-branch', 'content', 'posts'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'clean-branch', 'content', 'posts', `post.hello.${generateId()}.json`),
      '{}',
      'utf-8',
    )

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries[0].kind).toBe('healthy')
    expect(entries[0].duplicateContentIds).toBeUndefined()
  })

  it('classifies a healthy branch with a duplicate content ID, reporting it without downgrading kind (the branch stays usable)', async () => {
    const root = await tmpDir()
    await createHealthyBranch(root, 'dup-branch')
    const postsDir = path.join(root, 'dup-branch', 'content', 'posts')
    await fs.mkdir(postsDir, { recursive: true })
    const dupId = generateId()
    // Matches renameEntry()'s documented crash window: fs.link() succeeded,
    // the crash landed before fs.unlink() removed the old name.
    await fs.writeFile(path.join(postsDir, `post.old-slug.${dupId}.json`), '{}', 'utf-8')
    await fs.writeFile(path.join(postsDir, `post.new-slug.${dupId}.json`), '{}', 'utf-8')

    // The scan warns on quarantine, which is the POINT -- an operator has to
    // learn a duplicate exists. Swallow and assert it rather than let it leak
    // as incidental console noise (CI fails hard on unswallowed output; see
    // vitest.config.ts's onConsoleLog, which only bites when process.env.CI
    // is set, so a green local run does not prove this).
    const consoleSpy = mockConsole()
    let entries: Awaited<ReturnType<typeof scanBranchHealth>>
    try {
      entries = await scanBranchHealth(root, { baseBranchName: 'main' })
      expect(consoleSpy).toHaveWarned(dupId)
    } finally {
      consoleSpy.restore()
    }
    expect(entries).toHaveLength(1)
    // Still 'healthy' -- a content-tree duplicate degrades content operations
    // for that one ID, it does not make branch.json (or the branch) corrupt.
    expect(entries[0].kind).toBe('healthy')
    expect(entries[0].branch?.name).toBe('dup-branch')
    expect(entries[0].duplicateContentIds).toHaveLength(1)
    expect(entries[0].duplicateContentIds?.[0]).toMatchObject({
      id: dupId,
      keptPath: `content/posts/post.new-slug.${dupId}.json`,
      droppedPaths: [`content/posts/post.old-slug.${dupId}.json`],
    })
  })

  it('respects a non-default contentRootName when scanning for duplicate content IDs', async () => {
    const root = await tmpDir()
    await createHealthyBranch(root, 'custom-root-branch')
    const postsDir = path.join(root, 'custom-root-branch', 'my-content', 'posts')
    await fs.mkdir(postsDir, { recursive: true })
    const dupId = generateId()
    await fs.writeFile(path.join(postsDir, `post.a.${dupId}.json`), '{}', 'utf-8')
    await fs.writeFile(path.join(postsDir, `post.b.${dupId}.json`), '{}', 'utf-8')

    // Default contentRootName ('content') never sees 'my-content' -- no signal,
    // and therefore no warning either: the scan cannot warn about a duplicate
    // it never looked for. Asserting silence here is the other half of the
    // contentRootName contract.
    const quietSpy = mockConsole()
    let withDefault: Awaited<ReturnType<typeof scanBranchHealth>>
    try {
      withDefault = await scanBranchHealth(root, { baseBranchName: 'main' })
    } finally {
      quietSpy.restore()
    }
    expect(withDefault[0].duplicateContentIds).toBeUndefined()

    const consoleSpy = mockConsole()
    let withCustomRoot: Awaited<ReturnType<typeof scanBranchHealth>>
    try {
      withCustomRoot = await scanBranchHealth(root, {
        baseBranchName: 'main',
        contentRootName: 'my-content',
      })
      expect(consoleSpy).toHaveWarned(dupId)
    } finally {
      consoleSpy.restore()
    }
    expect(withCustomRoot[0].duplicateContentIds).toHaveLength(1)
  })

  it('classifies a directory with invalid-JSON branch.json as corrupt-metadata', async () => {
    const root = await tmpDir()
    await createCorruptBranch(root, 'broken-branch')

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ dirName: 'broken-branch', kind: 'corrupt-metadata' })
    expect(entries[0].parseError).toBeTruthy()
    expect(entries[0].metaMtime).toBeTruthy()
    expect(entries[0].branch).toBeUndefined()
    // [REDACT] parseError must be the raw JSON.parse cause, not the
    // BranchMetadataCorruptError's path-qualified `message` -- never leaks
    // the absolute workspace root to a client.
    expect(entries[0].parseError).not.toMatch(/^Corrupt branch metadata/)
    expect(entries[0].parseError).not.toContain(root)
  })

  it('classifies a non-SyntaxError loadOnly failure (branch.json is a directory) as corrupt-metadata', async () => {
    const root = await tmpDir()
    const metaDir = path.join(root, 'weird-branch', '.canopy-meta')
    await fs.mkdir(path.join(metaDir, 'branch.json'), { recursive: true })

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('corrupt-metadata')
    expect(entries[0].dirName).toBe('weird-branch')
    // [REDACT] Node errors (EISDIR here) embed the absolute path in their
    // `message` -- only the error `code` is safe to surface to a client.
    expect(entries[0].parseError).toBe('EISDIR')
    expect(entries[0].parseError).not.toContain(root)
  })

  it('classifies a directory with no branch.json as orphan, reporting hasGitDir and dir age', async () => {
    const root = await tmpDir()
    await createOrphanBranch(root, 'partial-clone', { withGitDir: true })
    await createOrphanBranch(root, 'no-git-orphan', { withGitDir: false })

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries).toHaveLength(2)

    const withGit = entries.find((e) => e.dirName === 'partial-clone')
    expect(withGit?.kind).toBe('orphan')
    expect(withGit?.hasGitDir).toBe(true)
    expect(withGit?.dirMtime).toBeTruthy()
    expect(withGit?.ageMs).toBeGreaterThanOrEqual(0)

    const withoutGit = entries.find((e) => e.dirName === 'no-git-orphan')
    expect(withoutGit?.kind).toBe('orphan')
    expect(withoutGit?.hasGitDir).toBe(false)
  })

  it('reports provisioningLock with mtime/age for an orphan when the init lock exists', async () => {
    const root = await tmpDir()
    await createOrphanBranch(root, 'mid-clone')
    await createInitLock(root, 'mid-clone', 2 * 60_000)

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries).toHaveLength(1)
    expect(entries[0].provisioningLock).toBeTruthy()
    expect(entries[0].provisioningLock?.mtime).toBeTruthy()
    expect(entries[0].provisioningLock?.ageMs).toBeGreaterThanOrEqual(2 * 60_000 - 1000)
  })

  it('reports provisioningLock for a corrupt-metadata dir too', async () => {
    const root = await tmpDir()
    await createCorruptBranch(root, 'broken-with-lock')
    await createInitLock(root, 'broken-with-lock')

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries[0].kind).toBe('corrupt-metadata')
    expect(entries[0].provisioningLock).toBeTruthy()
  })

  it('omits provisioningLock when no init lock exists', async () => {
    const root = await tmpDir()
    await createOrphanBranch(root, 'no-lock-orphan')

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries[0].provisioningLock).toBeUndefined()
  })

  it('never reports provisioningLock for healthy branches', async () => {
    const root = await tmpDir()
    await createHealthyBranch(root, 'main')
    // A lock lingering after a completed provision must not be surfaced for
    // a healthy branch -- only orphan/corrupt entries carry this field.
    await createInitLock(root, 'main')

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries[0].kind).toBe('healthy')
    expect(entries[0].provisioningLock).toBeUndefined()
  })

  it('skips dot-prefixed directories and plain files at the root', async () => {
    const root = await tmpDir()
    await createHealthyBranch(root, 'main')
    await fs.mkdir(path.join(root, '.trash-old-branch-20200101T000000Z'), { recursive: true })
    await fs.mkdir(path.join(root, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(root, 'branches.json'), '{}', 'utf-8')

    const entries = await scanBranchHealth(root, { baseBranchName: 'main' })
    expect(entries).toHaveLength(1)
    expect(entries[0].dirName).toBe('main')
  })
})
