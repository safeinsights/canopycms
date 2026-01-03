import fs from 'node:fs/promises'
import path from 'node:path'

import type { CanopyConfig } from './config'
import { ensureBranchRoot } from './paths'
import { getBranchMetadataFileManager } from './branch-metadata'
import type { BranchAccessControl, BranchContext, CanopyUserId } from './types'
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
    const baseBranch = this.config.defaultBaseBranch ?? 'main'
    const remoteUrl = await GitManager.resolveRemoteUrl({
      mode: options.mode,
      remoteUrl: options.remoteUrl,
      defaultRemoteUrl: this.config.defaultRemoteUrl,
      baseBranch,
      sourceRoot: this.config.sourceRoot,
    })
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
        throw new Error(
          'CanopyCMS: defaultRemoteUrl (or CANOPYCMS_REMOTE_URL) is required to init branch workspaces',
        )
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

  async openOrCreateBranch(options: OpenBranchOptions): Promise<BranchContext> {
    const { branchName, mode, basePathOverride, title, description, access, createdBy, remoteUrl } =
      options
    const {
      branchRoot,
      baseRoot,
      branchName: safeName,
    } = await ensureBranchRoot({
      mode,
      branchName,
      basePathOverride,
    })

    await this.ensureGitWorkspace({ branchRoot, branchName: safeName, mode, remoteUrl })

    // save() handles both creation and updates, preserving existing values and invalidating registry
    const metadata = getBranchMetadataFileManager(branchRoot, baseRoot)
    const meta = await metadata.save({
      branch: {
        name: safeName,
        title,
        description,
        access,
        createdBy,
      },
    })

    return {
      branch: meta.branch,
      branchRoot,
      baseRoot,
    }
  }
}

export { loadBranchContext } from './branch-metadata'
