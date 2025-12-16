import path from 'node:path'

import {
  simpleGit,
  type ConfigListSummary,
  type SimpleGit,
  type SimpleGitOptions,
  type StatusResult,
} from 'simple-git'

export interface GitManagerOptions {
  repoPath: string
  baseBranch?: string
  remote?: string
}

export interface GitStatus extends Pick<
  StatusResult,
  'files' | 'ahead' | 'behind' | 'current' | 'tracking'
> {}

export class GitManager {
  private readonly git: SimpleGit
  private readonly repoPath: string
  private readonly baseBranch: string
  private readonly remote: string

  constructor(options: GitManagerOptions, gitOptions?: Partial<SimpleGitOptions>) {
    this.repoPath = path.resolve(options.repoPath)
    this.baseBranch = options.baseBranch ?? 'main'
    this.remote = options.remote ?? 'origin'
    this.git = simpleGit({ baseDir: this.repoPath, ...gitOptions })
  }

  static async cloneRepo(
    remoteUrl: string,
    targetPath: string,
    baseBranch = 'main',
  ): Promise<void> {
    const git = simpleGit()
    await git.clone(remoteUrl, targetPath, ['--branch', baseBranch, '--single-branch'])
  }

  async status(): Promise<GitStatus> {
    const s = await this.git.status()
    return {
      files: s.files,
      ahead: s.ahead,
      behind: s.behind,
      current: s.current,
      tracking: s.tracking,
    }
  }

  async checkoutBranch(branch: string): Promise<void> {
    const branches = await this.git.branch()
    if (branches.all.includes(branch)) {
      await this.git.checkout(branch)
      return
    }

    const remoteRef = `${this.remote}/${this.baseBranch}`
    try {
      await this.git.fetch(this.remote, this.baseBranch)
    } catch {
      // Best-effort; will fall back to local base branch below if fetch fails
    }
    try {
      await this.git.checkoutBranch(branch, remoteRef)
      return
    } catch {
      const baseExists = branches.all.includes(this.baseBranch)
      if (baseExists) {
        await this.git.checkout(['-B', branch, this.baseBranch])
        return
      }
      await this.git.checkoutLocalBranch(branch)
    }
  }

  async pullBase(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    await this.git.merge([`${this.remote}/${this.baseBranch}`])
  }

  async rebaseOntoBase(): Promise<void> {
    await this.git.fetch(this.remote, this.baseBranch)
    await this.git.rebase([`${this.remote}/${this.baseBranch}`])
  }

  async add(files: string[]): Promise<void> {
    await this.git.add(files)
  }

  async commit(message: string): Promise<void> {
    await this.git.commit(message)
  }

  async push(branch?: string): Promise<void> {
    const target = branch ?? (await this.git.revparse(['--abbrev-ref', 'HEAD']))
    await this.git.push(this.remote, target)
  }

  async ensureAuthor(author: { name: string; email: string }): Promise<void> {
    const config = (await this.git.listConfig()) as ConfigListSummary
    const currentName = config.all['user.name']
    const currentEmail = config.all['user.email']
    if (currentName !== author.name) {
      await this.git.addConfig('user.name', author.name)
    }
    if (currentEmail !== author.email) {
      await this.git.addConfig('user.email', author.email)
    }
  }

  async ensureRemote(remoteUrl: string): Promise<void> {
    const remotes = await this.git.getRemotes(true)
    const existing = remotes.find((r) => r.name === this.remote)
    if (!existing) {
      await this.git.addRemote(this.remote, remoteUrl)
      return
    }
    const currentUrl = existing.refs.push ?? existing.refs.fetch
    if (currentUrl && currentUrl !== remoteUrl) {
      await this.git.remote(['set-url', this.remote, remoteUrl])
    }
  }
}
