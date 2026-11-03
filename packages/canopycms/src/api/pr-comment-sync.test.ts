import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CanopyConfig } from '../config'
import type { GitHubService } from '../github-service'
import type { BranchContext } from '../types'
import { CommentStore } from '../comment-store'
import { PR_COMMENTS_END, PR_COMMENTS_START, buildPrSection } from '../submission-attribution'
import { SYNC_PR_COMMENTS_ACTION } from '../pr-comments'
import { enqueueTask, listTasks } from '../task-queue/cms-task-queue'
import { getTaskQueueDir } from '../task-queue/task-queue-config'
import { createMockApiContext, createMockBranchContext } from '../test-utils'
import { mockConsole } from '../test-utils/console-spy'
import { syncPrComments } from './pr-comment-sync'

const config: CanopyConfig = {
  gitBotAuthorName: 'Canopy Bot',
  gitBotAuthorEmail: 'bot@example.com',
  defaultBaseBranch: 'main',
  mode: 'prod',
  deployedAs: 'server',
  contentRoot: 'content',
}

let tmp: string
let branchRoot: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-pr-comment-sync-'))
  branchRoot = path.join(tmp, 'branch')
  await fs.mkdir(branchRoot, { recursive: true })
  vi.stubEnv('CANOPYCMS_WORKSPACE_ROOT', tmp)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(tmp, { recursive: true, force: true })
})

const branchWithPr = (overrides: Partial<BranchContext['branch']> = {}): BranchContext => {
  const context = createMockBranchContext({ branchName: 'feature/x', branchRoot })
  return {
    ...context,
    branch: {
      ...context.branch,
      status: 'submitted',
      pullRequestNumber: 7,
      editorUrl: 'https://cms.example.org/edit',
      ...overrides,
    },
  }
}

/** A PR body as a submit writes it, with no threads yet, under some human text. */
const submittedBody = `Reviewer notes\n\n${buildPrSection({ changedPaths: ['a.md'] })}`

const github = (body: string | null = submittedBody, state = 'open') => {
  const service = {
    getPullRequest: vi.fn().mockResolvedValue({ number: 7, state, body }),
    updatePullRequest: vi.fn().mockResolvedValue(undefined),
  }
  return service
}

const directCtx = (service: ReturnType<typeof github>, overrides: Partial<CanopyConfig> = {}) =>
  createMockApiContext({
    services: {
      config: { ...config, ...overrides },
      githubService: service as unknown as GitHubService,
    },
  })

const addThread = (text: string) =>
  new CommentStore(branchRoot).addComment({
    userId: 'u1',
    text,
    type: 'entry',
    entryPath: 'content/pages/home',
  })

describe('syncPrComments, direct path', () => {
  it('re-renders only the comment block from comments.json, keeping the rest of the body', async () => {
    await addThread('Fix the intro')
    const service = github()

    await syncPrComments(directCtx(service), branchWithPr())

    expect(service.updatePullRequest).toHaveBeenCalledTimes(1)
    const [number, update] = service.updatePullRequest.mock.calls[0]!
    expect(number).toBe(7)
    expect(Object.keys(update)).toEqual(['body'])
    const block = update.body.slice(
      update.body.indexOf(PR_COMMENTS_START),
      update.body.indexOf(PR_COMMENTS_END),
    )
    expect(block).toContain('**1 unresolved editor comment thread**')
    expect(block).toContain(
      '`Fix the intro` ([open in editor](https://cms.example.org/edit?branch=feature%2Fx&entry=content%2Fpages%2Fhome))',
    )
    expect(update.body.replace(block, '')).toBe(
      submittedBody.replace(`${PR_COMMENTS_START}\nNo editor comments.\n`, ''),
    )
  })

  it('links from config.editorUrl over the URL recorded at submit', async () => {
    await addThread('Hi')
    const service = github()

    await syncPrComments(
      directCtx(service, { editorUrl: 'https://editor.example.org/cms' }),
      branchWithPr(),
    )

    expect(service.updatePullRequest.mock.calls[0]![1].body).toContain(
      '(https://editor.example.org/cms?branch=feature%2Fx&entry=',
    )
  })

  it('links a namespace branch by its short name, which ?branch= resolves', async () => {
    await addThread('Hi')
    const service = github()

    await syncPrComments(directCtx(service), branchWithPr({ name: 'canopycms/prod/spring' }))

    expect(service.updatePullRequest.mock.calls[0]![1].body).toContain(
      '(https://cms.example.org/edit?branch=spring&entry=',
    )
  })

  it('writes nothing when the block is unchanged or missing', async () => {
    for (const body of [submittedBody, 'A body a human rewrote', null]) {
      const service = github(body)
      await syncPrComments(directCtx(service), branchWithPr())
      expect(service.getPullRequest).toHaveBeenCalledTimes(1)
      expect(service.updatePullRequest).not.toHaveBeenCalled()
    }
  })

  it('does nothing without an open PR', async () => {
    await addThread('Hi')
    for (const branch of [
      branchWithPr({ pullRequestNumber: undefined }),
      branchWithPr({ pullRequestState: 'merged' }),
      branchWithPr({ pullRequestState: 'closed' }),
      branchWithPr({ status: 'archived' }),
    ]) {
      const service = github()
      await syncPrComments(directCtx(service), branch)
      expect(service.getPullRequest).not.toHaveBeenCalled()
    }
    const closedOnGitHub = github(submittedBody, 'closed')
    await syncPrComments(directCtx(closedOnGitHub), branchWithPr())
    expect(closedOnGitHub.updatePullRequest).not.toHaveBeenCalled()
  })

  it('does nothing in a mode without pull requests', async () => {
    await addThread('Hi')
    const service = github()
    await syncPrComments(directCtx(service, { mode: 'dev' }), branchWithPr())
    expect(service.getPullRequest).not.toHaveBeenCalled()
  })

  it('gives up after 10 seconds, so a slow GitHub never holds the comment request', async () => {
    vi.useFakeTimers()
    const consoleSpy = mockConsole()
    try {
      const service = github()
      service.getPullRequest.mockReturnValue(new Promise(() => {}))

      const synced = syncPrComments(directCtx(service), branchWithPr())
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(synced).resolves.toBeUndefined()

      expect(service.getPullRequest.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
      expect(service.getPullRequest.mock.calls[0]?.[1].aborted).toBe(true)
      expect(consoleSpy).toHaveWarned(/review state on PR #7.*did not answer within 10 s/)
    } finally {
      consoleSpy.restore()
      vi.useRealTimers()
    }
  })

  it('writes nothing, and warns, when comments.json cannot be read', async () => {
    const consoleSpy = mockConsole()
    await fs.mkdir(path.join(branchRoot, '.canopy-meta'), { recursive: true })
    await fs.writeFile(path.join(branchRoot, '.canopy-meta', 'comments.json'), '{not json')
    const service = github()

    await syncPrComments(directCtx(service), branchWithPr())

    expect(service.updatePullRequest).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveWarned(/editor comments of feature\/x/)
    consoleSpy.restore()
  })

  it('logs and returns when GitHub fails', async () => {
    const consoleSpy = mockConsole()
    await addThread('Hi')
    const service = github()
    service.updatePullRequest.mockRejectedValue(new Error('502 Bad Gateway'))

    await expect(syncPrComments(directCtx(service), branchWithPr())).resolves.toBeUndefined()

    expect(consoleSpy).toHaveWarned(/review state on PR #7 for feature\/x.*502/)
    consoleSpy.restore()
  })
})

describe('syncPrComments, queued path', () => {
  const queuedCtx = () => createMockApiContext({ services: { config } })
  const pending = () => listTasks(getTaskQueueDir(config), 'pending')

  it('queues one task per branch and PR while one is pending', async () => {
    await syncPrComments(queuedCtx(), branchWithPr())
    await syncPrComments(queuedCtx(), branchWithPr())
    await syncPrComments(queuedCtx(), branchWithPr({ name: 'feature/y' }))

    const tasks = (await pending()).sort((a, b) =>
      String(a.payload.branch).localeCompare(String(b.payload.branch)),
    )
    expect(tasks.map((t) => [t.action, t.payload])).toEqual([
      [
        'sync-pr-comments',
        {
          branch: 'feature/x',
          pullRequestNumber: 7,
          editorUrl: 'https://cms.example.org/edit',
          editorBranch: 'feature/x',
        },
      ],
      [
        'sync-pr-comments',
        {
          branch: 'feature/y',
          pullRequestNumber: 7,
          editorUrl: 'https://cms.example.org/edit',
          editorBranch: 'feature/y',
        },
      ],
    ])
  })

  it('queues a namespace branch with its short name for the links', async () => {
    await syncPrComments(queuedCtx(), branchWithPr({ name: 'canopycms/prod/spring' }))

    expect((await pending()).map((t) => t.payload)).toEqual([
      {
        branch: 'canopycms/prod/spring',
        pullRequestNumber: 7,
        editorUrl: 'https://cms.example.org/edit',
        editorBranch: 'spring',
      },
    ])
  })

  it("queues beside the worker's review-only task, which carries no comment", async () => {
    await enqueueTask(getTaskQueueDir(config), {
      action: SYNC_PR_COMMENTS_ACTION,
      payload: { branch: 'feature/x', pullRequestNumber: 7, reviewBlockOnly: true },
    })

    await syncPrComments(queuedCtx(), branchWithPr())

    expect(await pending()).toHaveLength(2)
  })

  it('queues again for a new PR while a task for the old one is pending', async () => {
    await syncPrComments(queuedCtx(), branchWithPr())
    await syncPrComments(queuedCtx(), branchWithPr({ pullRequestNumber: 8 }))
    expect((await pending()).map((t) => t.payload.pullRequestNumber).sort()).toEqual([7, 8])
  })

  it('queues nothing without an open PR', async () => {
    await syncPrComments(queuedCtx(), branchWithPr({ pullRequestNumber: undefined }))
    await syncPrComments(queuedCtx(), branchWithPr({ pullRequestState: 'merged' }))
    expect(await pending()).toEqual([])
  })
})
