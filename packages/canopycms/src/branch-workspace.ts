import fs from 'node:fs/promises'
import path from 'node:path'

import type { CanopyConfig } from './config'
import { ensureBranchRoot, resolveBranchPath } from './paths'
import { BranchMetadata, type BranchMetadataFile } from './branch-metadata'
import { BranchRegistry } from './branch-registry'
import type { BranchAccessControl, BranchState, CanopyUserId } from './types'
import type { BranchMode } from './paths'
import { GitManager } from './git-manager'

export interface OpenBranchOptions {
  branchName: string
  mode: BranchMode
  basePathOverride?: string
  title?: string
  description?: string
  access?: BranchAccessControl
  createdBy: CanopyUserId
  remoteUrl?: string
}

export interface BranchWorkspace {
  branchName: string
  branchRoot: string
  baseRoot: string
  metadataRoot: string
  metadata: BranchMetadataFile
  state: BranchState
}

/**
 * Manages per-branch filesystem workspace: resolves root, ensures metadata,
 * and updates the branch registry.
 */
export class BranchWorkspaceManager {
  private readonly config: CanopyConfig

  constructor(config: CanopyConfig) {
    this.config = config
  }

  private async ensureGitWorkspace(options: {
    branchRoot: string
    branchName: string
    mode: BranchMode
    remoteUrl?: string
  }) {
    const remoteUrl = options.remoteUrl ?? this.config.defaultRemoteUrl ?? process.env.CANOPYCMS_REMOTE_URL
    const baseBranch = this.config.defaultBaseBranch ?? 'main'
    const remoteName = this.config.defaultRemoteName ?? 'origin'
    const authorName = this.config.gitBotAuthorName
    const authorEmail = this.config.gitBotAuthorEmail
    if (!authorName || !authorEmail) {
      throw new Error('CanopyCMS: gitBotAuthorName and gitBotAuthorEmail are required')
    }

    const hasGit = async () => {
      try {
        const stat = await fs.stat(path.join(options.branchRoot, '.git'))
        return stat.isDirectory()
      } catch (err: any) {
        if (err?.code === 'ENOENT') return false
        throw err
      }
    }

    const repoExists = await hasGit()
    if (!repoExists) {
      if (options.mode === 'local-simple') {
        throw new Error(`CanopyCMS: expected git repo at ${options.branchRoot}`)
      }
      if (!remoteUrl) {
        throw new Error('CanopyCMS: defaultRemoteUrl (or CANOPYCMS_REMOTE_URL) is required to init branch workspaces')
      }
      await GitManager.cloneRepo(remoteUrl, options.branchRoot, baseBranch)
    }

    const git = new GitManager({
      repoPath: options.branchRoot,
      baseBranch,
      remote: remoteName,
    })
    if (remoteUrl) {
      await git.ensureRemote(remoteUrl)
    }
    await git.ensureAuthor({ name: authorName, email: authorEmail })
    await git.checkoutBranch(options.branchName)
  }

  async openOrCreateBranch(options: OpenBranchOptions): Promise<BranchWorkspace> {
    const { branchName, mode, basePathOverride, title, description, access, createdBy, remoteUrl } = options
    const { branchRoot, baseRoot, metadataRoot, branchName: safeName } = await ensureBranchRoot({
      mode,
      branchName,
      basePathOverride,
    })

    await this.ensureGitWorkspace({ branchRoot, branchName: safeName, mode, remoteUrl })

    const metadata = new BranchMetadata(metadataRoot)
    let meta = await metadata.load()
    const now = new Date().toISOString()

    if (!meta || meta.branch.name !== safeName) {
      meta = {
        schemaVersion: 1,
        branch: {
          name: safeName,
          title,
          description,
          status: 'editing',
          access: access ?? {},
          createdBy,
          createdAt: now,
          updatedAt: now,
        },
      }
      await metadata.save(meta)
    } else if (title || description || access) {
      meta = await metadata.update({
        branch: {
          title: title ?? meta.branch.title,
          description: description ?? meta.branch.description,
          access: access ?? meta.branch.access,
        },
      })
    }

    const registry = new BranchRegistry(baseRoot)
    const state: BranchState = {
      ...BranchMetadata.toBranchState(meta),
      workspaceRoot: branchRoot,
      metadataRoot,
      baseRoot,
    }
    await registry.upsert(state)

    return {
      branchName: safeName,
      branchRoot,
      baseRoot,
      metadataRoot,
      metadata: meta,
      state,
    }
  }
}

export const loadBranchState = async (options: {
  branchName: string
  mode: BranchMode
  basePathOverride?: string
  registry?: BranchRegistry
}): Promise<BranchState | null> => {
  const { branchRoot, baseRoot, metadataRoot, branchName: safeName } = resolveBranchPath({
    branchName: options.branchName,
    mode: options.mode,
    basePathOverride: options.basePathOverride,
  })
  const registry = options.registry ?? new BranchRegistry(baseRoot)
  const registryEntry = await registry.get(safeName)
  const meta = await new BranchMetadata(metadataRoot).load()

  if (meta) {
    const state: BranchState = {
      ...BranchMetadata.toBranchState(meta),
      workspaceRoot: branchRoot,
      baseRoot,
      metadataRoot,
    }
    if (
      !registryEntry ||
      registryEntry.workspaceRoot !== state.workspaceRoot ||
      registryEntry.metadataRoot !== state.metadataRoot
    ) {
      await registry.upsert(state)
    }
    return state
  }

  if (registryEntry) {
    return {
      ...registryEntry,
      workspaceRoot: registryEntry.workspaceRoot ?? branchRoot,
      baseRoot: registryEntry.baseRoot ?? baseRoot,
      metadataRoot: registryEntry.metadataRoot ?? metadataRoot,
    }
  }

  return null
}
