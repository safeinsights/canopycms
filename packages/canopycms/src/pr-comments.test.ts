import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBranchMetadataFileManager } from './branch-metadata'
import { CommentStore } from './comment-store'
import { refreshCommentsBlock, renderPrCommentsBody } from './pr-comments'
import {
  PR_COMMENTS_END,
  PR_COMMENTS_START,
  PR_REVIEW_START,
  PR_SECTION_END,
  PR_SECTION_START,
  buildPrSection,
  buildReviewBlock,
  mergeReviewBlock,
} from './submission-attribution'
import type { BranchReview, BranchStatus } from './types'

const approved: BranchReview = {
  state: 'approved',
  by: { userId: 'rev1', name: 'Rae Viewer' },
  at: '2026-10-28T14:05:00.000Z',
}
const changesRequested: BranchReview = { ...approved, state: 'changes-requested' }

let tmp: string
let branchRoot: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-pr-comments-'))
  branchRoot = path.join(tmp, 'branch')
  await fs.mkdir(branchRoot, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const seedBranch = (status: BranchStatus, review?: BranchReview) =>
  getBranchMetadataFileManager(branchRoot, tmp, { settleMs: 0 }).save({
    branch: { name: 'feature/x', status, createdBy: 'u1', ...(review ? { review } : {}) },
  })

const addComment = () =>
  new CommentStore(branchRoot).addComment({ userId: 'u1', text: 'Fix the intro', type: 'branch' })

/** A PR body as a submit writes it, under some human text. */
const submittedBody = `Notes\n\n${buildPrSection({ changedPaths: ['a.md'] })}`

const render = (body: string | null | undefined = submittedBody, warn = vi.fn()) =>
  renderPrCommentsBody({ branchRoot, branch: 'feature/x', body, warn })

describe('renderPrCommentsBody', () => {
  it('re-renders the comment block and the review block together', async () => {
    await seedBranch('approved', approved)
    await addComment()

    const body = (await render())!

    expect(body.startsWith('Notes\n\n')).toBe(true)
    expect(body).toContain('**1 unresolved editor comment thread**')
    expect(body).toContain('Approved in CanopyCMS by `Rae Viewer` on 2026-10-28 14:05 UTC.')
    expect(body).not.toContain('Not yet reviewed')
  })

  it('renders a request for changes as stored, on a branch back in editing', async () => {
    await seedBranch('editing', changesRequested)

    expect(await render()).toContain('Changes requested in CanopyCMS by `Rae Viewer`')
  })

  it('writes nothing when neither block changed', async () => {
    await seedBranch('submitted')
    expect(await render()).toBeUndefined()
  })

  it('updates the comments of a body that has no review block', async () => {
    await seedBranch('approved', approved)
    await addComment()
    const noReviewBlock = submittedBody.replace(buildReviewBlock(undefined) + '\n\n', '')
    expect(noReviewBlock).not.toContain(PR_REVIEW_START)

    const body = (await render(noReviewBlock))!

    expect(body).toContain('**1 unresolved editor comment thread**')
    expect(body).not.toContain(PR_REVIEW_START)
  })

  it('updates the review of a body that has no comment block', async () => {
    await seedBranch('approved', approved)
    const noCommentBlock = submittedBody.replace(
      new RegExp(`${PR_COMMENTS_START}[\\s\\S]*?${PR_COMMENTS_END}\\n`),
      '',
    )
    expect(noCommentBlock).not.toContain(PR_COMMENTS_START)

    const body = (await render(noCommentBlock))!

    expect(body).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(body).not.toContain(PR_COMMENTS_START)
  })

  it('writes nothing for a body with no canopycms section, or no body', async () => {
    await seedBranch('approved', approved)
    expect(await render('rewritten by a human')).toBeUndefined()
    expect(await render(null)).toBeUndefined()
  })

  const withApprovedBody = () =>
    submittedBody.replace(buildReviewBlock(undefined), buildReviewBlock(approved))

  it('leaves the review block as it is, silently, when branch.json is missing', async () => {
    await addComment()
    const warn = vi.fn()

    const body = (await render(withApprovedBody(), warn))!

    expect(body).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(body).toContain('**1 unresolved editor comment thread**')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the review block, warns, and still updates the comments when branch.json cannot be read', async () => {
    await addComment()
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'branch.json'), '{not json')
    const warn = vi.fn()

    const body = (await render(withApprovedBody(), warn))!

    expect(body).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(body).toContain('**1 unresolved editor comment thread**')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('review state'))
  })

  it('keeps the comment block, warns, and still updates the review when comments.json cannot be read', async () => {
    await seedBranch('approved', approved)
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'comments.json'), '{not json')
    const warn = vi.fn()

    const body = (await render(submittedBody, warn))!

    expect(body).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(body).toContain('No editor comments.')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('editor comments'))
  })

  it('isolates a comments.json that parses but has no threads object', async () => {
    await seedBranch('approved', approved)
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'comments.json'), '{"threads":null}')
    const warn = vi.fn()

    const body = (await render(submittedBody, warn))!

    expect(body).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('editor comments'))
  })

  it('isolates a branch.json that fails its schema', async () => {
    await addComment()
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'branch.json'), '{}')
    const warn = vi.fn()

    const body = (await render(withApprovedBody(), warn))!

    expect(body).toContain('**1 unresolved editor comment thread**')
    expect(body).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('review state'))
  })

  describe('an IO fault that may pass is thrown, not turned into a warning', () => {
    const fault = (code: string) => Object.assign(new Error(`${code}: read failed`), { code })

    afterEach(() => vi.restoreAllMocks())

    it.each(['EIO', 'ESTALE', 'EACCES'])('from comments.json (%s)', async (code) => {
      await seedBranch('approved', approved)
      vi.spyOn(CommentStore.prototype, 'listThreadsStrict').mockRejectedValue(fault(code))
      const warn = vi.fn()

      await expect(render(submittedBody, warn)).rejects.toThrow(code)
      expect(warn).not.toHaveBeenCalled()
    })

    it.each(['EIO', 'ESTALE', 'EACCES'])('from branch.json (%s)', async (code) => {
      await seedBranch('approved', approved)
      const realReadFile = fs.readFile.bind(fs)
      vi.spyOn(fs, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) =>
        String(file).endsWith('branch.json')
          ? Promise.reject(fault(code))
          : (realReadFile as (...a: unknown[]) => Promise<unknown>)(
              file,
              ...rest,
            )) as typeof fs.readFile)
      const warn = vi.fn()

      await expect(render(submittedBody, warn)).rejects.toThrow(code)
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('drops a malformed review from a body that showed one', async () => {
    await seedBranch('submitted')
    const file = path.join(branchRoot, '.canopy-meta', 'branch.json')
    const json = JSON.parse(await fs.readFile(file, 'utf8'))
    json.branch.review = { state: 'approved' }
    await fs.writeFile(file, JSON.stringify(json))
    const withReview = submittedBody.replace(
      buildReviewBlock(undefined),
      buildReviewBlock(approved),
    )

    expect(await render(withReview)).toContain('Not yet reviewed in CanopyCMS.')
  })
})

describe('refreshCommentsBlock', () => {
  const section = buildPrSection({ changedPaths: ['a.md'], description: 'Desc' })
  const refresh = (warn = vi.fn()) =>
    refreshCommentsBlock({ branchRoot, branch: 'feature/x', section, warn })

  it.each(['submitted', 'approved'] as const)(
    'renders the review of a branch that is %s',
    async (status) => {
      await seedBranch(status, approved)
      await addComment()

      const refreshed = await refresh()

      expect(refreshed).toContain('Approved in CanopyCMS by `Rae Viewer`')
      expect(refreshed).toContain('**1 unresolved editor comment thread**')
      expect(refreshed.startsWith(PR_SECTION_START)).toBe(true)
      expect(refreshed.endsWith(PR_SECTION_END)).toBe(true)
    },
  )

  it('renders the stored review whatever the status, so a retried submit keeps a current request for changes', async () => {
    await seedBranch('editing', changesRequested)

    const refreshed = await refresh()

    expect(refreshed).toContain('Changes requested in CanopyCMS by `Rae Viewer`')
    expect(refreshed).not.toContain('Not yet reviewed')
  })

  it('renders not yet reviewed for a branch with no review', async () => {
    await seedBranch('submitted')
    expect(await refresh()).toContain('Not yet reviewed in CanopyCMS.')
  })

  it('keeps the queued review block when branch.json is missing, and still refreshes comments', async () => {
    await addComment()
    const queued = mergeReviewBlock(
      buildPrSection({ changedPaths: ['a.md'] }),
      buildReviewBlock(approved),
    )!

    const refreshed = await refreshCommentsBlock({
      branchRoot,
      branch: 'feature/x',
      section: queued,
      warn: vi.fn(),
    })

    expect(refreshed).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(refreshed).toContain('**1 unresolved editor comment thread**')
  })

  it('still refreshes the review when comments.json cannot be read, and warns', async () => {
    await seedBranch('approved', approved)
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'comments.json'), '{not json')
    const warn = vi.fn()

    const refreshed = await refresh(warn)

    expect(refreshed).toContain('Approved in CanopyCMS by `Rae Viewer`')
    expect(refreshed).toContain('No editor comments.')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('editor comments'))
  })
})
