/**
 * The GitHub gateway's branch policy: what it never does to GitHub, whatever the worker asks. The
 * task queue, remote.git and every branch's metadata are on the shared workspace, which the CMS
 * Lambda can write, so nothing here takes a branch to protect from a request.
 */
import { RESERVED_SETTINGS_BRANCH_PREFIX, sanitizeBranchName } from '../paths/branch-name'

/**
 * How long GitHub's default branch, once read, is taken to be still the default.
 * @internal Exported for tests.
 */
export const DEFAULT_BRANCH_TTL_MS = 10 * 60_000

/** The longest branch name the gateway takes, in characters. */
export const MAX_BRANCH_NAME_LENGTH = 255

/**
 * The longest pull request title the gateway sends, in UTF-16 code units.
 * @internal Exported for tests.
 */
export const MAX_PULL_REQUEST_TITLE_LENGTH = 1024

/**
 * The longest pull request body the gateway sends: GitHub's own limit.
 * @internal Exported for tests.
 */
export const MAX_PULL_REQUEST_BODY_LENGTH = 65_536

export type GatewayOperation = 'push' | 'delete' | 'pull-request'

export type RefusalReason = 'invalid' | 'protected' | 'settings' | 'not-a-commit' | 'too-long'

/**
 * Something the gateway refuses to do for any caller. No CanopyCMS flow asks for it, so no retry
 * can change the answer: the task runner fails such a task permanently, and a refusal never arms
 * the credential re-read (`LocalGitHubGateway.credentialed`).
 */
export class GatewayRefusalError extends Error {
  constructor(
    readonly operation: GatewayOperation,
    readonly branch: string,
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayRefusalError'
  }
}

const deleting = (branch: string) => `Refusing to delete ${JSON.stringify(branch)} on GitHub`
const openingFrom = (head: string) => `Refusing to open a pull request from ${JSON.stringify(head)}`

const PROTECTED_WHY =
  "it is protected (the base branch, GitHub's default branch, or a name protectedBranches " +
  'lists), which the CanopyCMS worker never changes. Nothing in CanopyCMS queues this; find out ' +
  'what wrote this task.'

/**
 * Why `branch` is not a name the gateway takes, before git sees it, or null. Printable ASCII only,
 * so no two names differ invisibly; no `"`, `%`, `{` or `}`, which reach URLs and log lines; no
 * leading `-`; no leading `refs/`, `heads/`, `tags/` or `remotes/`, which git's ref lookup could
 * read as some other ref than `refs/heads/<branch>`.
 * `git check-ref-format --branch` runs after this (`assertPlainBranchName`).
 */
export function branchNameProblem(branch: string): string | null {
  if (branch.length === 0 || branch.length > MAX_BRANCH_NAME_LENGTH) {
    return `a branch name is 1 to ${MAX_BRANCH_NAME_LENGTH} characters`
  }
  if (!/^[\x21-\x7e]+$/.test(branch)) return 'it is not printable ASCII'
  if (/["%{}]/.test(branch)) return 'it contains ", %, { or }'
  if (branch.startsWith('-')) return "it starts with '-'"
  if (/^(?:refs|heads|tags|remotes)\//i.test(branch)) {
    return "it starts with 'refs/', 'heads/', 'tags/' or 'remotes/'"
  }
  return null
}

/**
 * Why `pattern` cannot be a `protectedBranches` entry, or null. An entry is a branch name in which
 * `*` matches any run of characters, `/` included; nothing else is a wildcard. A character no
 * branch name can hold is refused rather than left to match nothing, so a list never protects
 * less than it seems to.
 * @internal Exported for tests.
 */
export function protectedPatternProblem(pattern: string): string | null {
  const named = branchNameProblem(pattern.replace(/\*/g, 'x'))
  if (named !== null) return named
  if (/[~^:?[\\]/.test(pattern))
    return 'only * is a wildcard, and ~ ^ : ? [ \\ are not in branch names'
  if (pattern.includes('..') || pattern.includes('@{') || pattern.includes('//')) {
    return "it contains '..', '@{' or '//'"
  }
  if (pattern.startsWith('/') || pattern.endsWith('/') || pattern.endsWith('.')) {
    return "it starts or ends with '/', or ends with '.'"
  }
  if (pattern.includes('*') && pattern.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)) {
    return `a glob never matches a settings branch, so one starting ${RESERVED_SETTINGS_BRANCH_PREFIX} matches nothing`
  }
  return null
}

/**
 * Whether `name` matches `pattern`, where `*` matches any run of characters. Never a regex.
 * @internal Exported for tests.
 */
export function matchesBranchPattern(pattern: string, name: string): boolean {
  const parts = pattern.split('*')
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (parts.length === 1) return pattern === name
  if (name.length < first.length + last.length) return false
  if (!name.startsWith(first) || !name.endsWith(last)) return false
  let at = first.length
  const end = name.length - last.length
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at)
    if (found === -1 || found + part.length > end) return false
    at = found + part.length
  }
  return true
}

export interface BranchPolicyOptions {
  /** The configured base branch (`CANOPYCMS_BASE_BRANCH`); never one read from the workspace. */
  baseBranch?: string
  /** Further protected names and `*` globs (`CANOPYCMS_PROTECTED_BRANCHES`). */
  protectedBranches?: readonly string[]
  /** Test seam: the clock {@link DEFAULT_BRANCH_TTL_MS} is measured on. */
  now?: () => number
}

/** Reads GitHub's default branch: null for a repository with none. */
export type DefaultBranchReader = () => Promise<string | null>

/**
 * The protected set and the settings rules.
 *
 * A branch is protected when it is the configured base branch, GitHub's default branch or a
 * `protectedBranches` entry, compared case-sensitively as GitHub compares refs. An exact entry
 * also matches a name that sanitizes to the same workspace directory; a glob never matches a
 * settings branch, whose plain push the worker needs. GitHub's default is re-read once
 * {@link DEFAULT_BRANCH_TTL_MS} has passed since the read that set it, so a change of default
 * takes up to that long to reach the set. A failed read is never cached: the operation fails.
 * Reads are not shared between concurrent callers, because a push reads inside a mirror session
 * and an operation that joined it from outside one would wait on that session.
 *
 * Settings branches are pushed plainly or not at all: no lease, no deletion, no pull request.
 * One is a name with the reserved prefix, the task runner's own test (`isSettingsBranch`): branch
 * creation refuses the prefix, while a configured settings name without it could be a content
 * branch's.
 */
export class BranchPolicy {
  private readonly exact: string[]
  private readonly globs: string[]
  private readonly now: () => number
  private githubDefault: { name: string | null; readAt: number } | null = null

  constructor(options: BranchPolicyOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    const entries = [...(options.protectedBranches ?? [])]
    for (const entry of entries) {
      const problem = protectedPatternProblem(entry)
      if (problem !== null) {
        throw new Error(`Invalid protectedBranches entry ${JSON.stringify(entry)}: ${problem}`)
      }
    }
    if (options.baseBranch !== undefined) entries.push(options.baseBranch)
    this.exact = entries.filter((entry) => !entry.includes('*'))
    this.globs = entries.filter((entry) => entry.includes('*'))
  }

  /** The protected set as it stands: configured names and globs, and GitHub's default as last read. */
  describe(): { configured: string[]; githubDefault: string | null } {
    return {
      configured: [...this.exact, ...this.globs],
      githubDefault: this.githubDefault?.name ?? null,
    }
  }

  /** Whether `branch` is protected; GitHub's default is read only when nothing else matches. */
  async isProtected(branch: string, readDefault: DefaultBranchReader): Promise<boolean> {
    if (this.matchesConfigured(branch)) return true
    const githubDefault = await this.githubDefaultBranch(readDefault)
    return githubDefault !== null && sameBranch(githubDefault, branch)
  }

  /** Refuse a push to a protected branch, or a leased push to a settings branch. */
  async assertPushAllowed(
    branch: string,
    lease: string | undefined,
    readDefault: DefaultBranchReader,
    refuse: (reason: 'protected' | 'settings') => Error,
  ): Promise<void> {
    if (await this.isProtected(branch, readDefault)) throw refuse('protected')
    if (lease !== undefined && this.isSettings(branch)) throw refuse('settings')
  }

  /** Refuse to delete a protected branch or a settings branch. */
  async assertDeleteAllowed(branch: string, readDefault: DefaultBranchReader): Promise<void> {
    if (this.isSettings(branch)) {
      throw new GatewayRefusalError(
        'delete',
        branch,
        'settings',
        `${deleting(branch)}: it is a settings branch, which is never deleted`,
      )
    }
    if (await this.isProtected(branch, readDefault)) {
      throw new GatewayRefusalError(
        'delete',
        branch,
        'protected',
        `${deleting(branch)}: ${PROTECTED_WHY}`,
      )
    }
  }

  /**
   * Refuse a pull request whose head is protected or a settings branch, or whose text is over its
   * cap. The base is not restricted: a branch keeps the base it was created from after the
   * adopter moves theirs, and a pull request merges nothing by itself.
   */
  async assertPullRequestAllowed(
    request: { head: string; title?: string; body?: string },
    readDefault: DefaultBranchReader,
  ): Promise<void> {
    const { head } = request
    assertPullRequestText(openingFrom(head), head, request)
    if (this.isSettings(head)) {
      throw new GatewayRefusalError(
        'pull-request',
        head,
        'settings',
        `${openingFrom(head)}: it is a settings branch, which never gets one`,
      )
    }
    if (await this.isProtected(head, readDefault)) {
      throw new GatewayRefusalError(
        'pull-request',
        head,
        'protected',
        `${openingFrom(head)}: ${PROTECTED_WHY}`,
      )
    }
  }

  private isSettings(branch: string): boolean {
    return branch.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)
  }

  private matchesConfigured(branch: string): boolean {
    return (
      this.exact.some((name) => sameBranch(name, branch)) ||
      // A glob never takes in a settings branch, whose one allowed push (plain) the worker needs:
      // `*-prod` would otherwise stop `canopycms-settings-prod` reaching GitHub.
      (!this.isSettings(branch) && this.globs.some((glob) => matchesBranchPattern(glob, branch)))
    )
  }

  private async githubDefaultBranch(readDefault: DefaultBranchReader): Promise<string | null> {
    const cached = this.githubDefault
    if (cached !== null && this.now() - cached.readAt < DEFAULT_BRANCH_TTL_MS) return cached.name
    return this.recordGitHubDefault(readDefault)
  }

  /**
   * Read GitHub's default branch now and keep it. A read that started before the one already kept
   * never replaces it.
   */
  async recordGitHubDefault(readDefault: DefaultBranchReader): Promise<string | null> {
    const readAt = this.now()
    const name = await readDefault()
    if (this.githubDefault === null || readAt >= this.githubDefault.readAt) {
      this.githubDefault = { name, readAt }
    }
    return name
  }
}

/** Refuse pull request text over its cap; `refusing` opens the message, `branch` names its head. */
export function assertPullRequestText(
  refusing: string,
  branch: string,
  text: { title?: string; body?: string },
): void {
  const over =
    (text.title?.length ?? 0) > MAX_PULL_REQUEST_TITLE_LENGTH
      ? `its title is longer than ${MAX_PULL_REQUEST_TITLE_LENGTH} characters`
      : (text.body?.length ?? 0) > MAX_PULL_REQUEST_BODY_LENGTH
        ? `its body is longer than ${MAX_PULL_REQUEST_BODY_LENGTH} characters`
        : null
  if (over !== null) {
    throw new GatewayRefusalError('pull-request', branch, 'too-long', `${refusing}: ${over}`)
  }
}

/** Equal, or naming the same workspace directory. */
function sameBranch(a: string, b: string): boolean {
  return a === b || sanitizeBranchName(a) === sanitizeBranchName(b)
}
