import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { clearHistoryRewrittenMarker, markHistoryRewritten } from './history-rewrite'

let contentBranchesPath: string
let branchPath: string

beforeEach(async () => {
  contentBranchesPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-history-rewrite-'))
  branchPath = path.join(contentBranchesPath, 'canopycms-prod-spring')
  await fs.mkdir(branchPath)
  await getBranchMetadataFileManager(branchPath, contentBranchesPath).save({
    branch: { name: 'canopycms/prod/spring', status: 'editing', createdBy: 'test' },
  })
})

afterEach(async () => {
  await fs.rm(contentBranchesPath, { recursive: true, force: true })
})

describe('the history-rewrite marker', () => {
  it("is set and cleared leaving the branch's stored name, not its directory's", async () => {
    const ctx = { contentBranchesPath }
    const read = async () => (await BranchMetadataFileManager.loadOnly(branchPath))?.branch

    await markHistoryRewritten(ctx, branchPath, 'canopycms-prod-spring', 'a'.repeat(40))
    expect(await read()).toMatchObject({
      name: 'canopycms/prod/spring',
      historyRewrittenFrom: 'a'.repeat(40),
    })

    await clearHistoryRewrittenMarker(ctx, branchPath, 'canopycms-prod-spring')
    const cleared = await read()
    expect(cleared?.name).toBe('canopycms/prod/spring')
    expect(cleared?.historyRewrittenFrom).toBeUndefined()
  })
})
