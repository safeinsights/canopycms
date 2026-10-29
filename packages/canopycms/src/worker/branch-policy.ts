/**
 * The GitHub gateway's branch policy: what it never does to GitHub, whatever the worker asks. The
 * task queue, remote.git and every branch's metadata are on the shared workspace, which the CMS
 * Lambda can write, so nothing here takes a branch to protect, or one to allow, from a request.
 */
import {
  DEFAULT_BRANCH_NAMESPACE_TEMPLATE,
  branchNamespaceProblem,
  namespaceAncestors,
  resolveBranchNamespaceTemplate,
} from '../operating-mode/branch-namespace'
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

export type RefusalReason =
  | 'invalid'
  | 'protected'
  | 'settings'
  | 'other-settings'
  | 'outside-namespace'
  | 'not-a-commit'
  | 'too-long'

/** The refusals {@link BranchPolicy.assertPushAllowed} makes. */
export type PushPolicyRefusal = 'protected' | 'settings' | 'other-settings' | 'outside-namespace'

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

const outsideNamespaceWhy = (namespace: string) =>
  `it is outside this deployment's branch namespace (names starting ${namespace}), and is ` +
  'neither its settings branch nor on its legacyBranches list. CanopyCMS creates every branch ' +
  'it edits in that namespace; a branch made before it reaches GitHub only once ' +
  'legacyBranches lists it.'

/**
 * Why the policy refuses to push `branch`, for `reason`, in `namespace`.
 * @internal Exported for tests.
 */
export function pushRefusalMessage(
  branch: string,
  reason: PushPolicyRefusal,
  namespace: string,
): string {
  const refusing = `Refusing to push ${JSON.stringify(branch)} to GitHub`
  switch (reason) {
    case 'protected':
      return `${refusing}: ${PROTECTED_WHY}`
    case 'settings':
      return (
        `${refusing} under a lease: a settings branch only ever fast-forwards. Find out what ` +
        'set a history-rewrite marker on it.'
      )
    case 'other-settings':
      return (
        `${refusing}: it is a settings branch, and not this deployment's, which is the only one ` +
        'this gateway pushes. Check that CANOPYCMS_DEPLOYMENT_NAME and CANOPYCMS_SETTINGS_BRANCH ' +
        "match the CMS's own settings branch; if they do, find out what asked for this push."
      )
    case 'outside-namespace':
      return `${refusing}: ${outsideNamespaceWhy(namespace)}`
  }
}

/** Why the gateway refuses to push `branch`, in the namespace, while GitHub has `blocker`. */
export function namespaceBlockedMessage(branch: string, blocker: string): string {
  return (
    `Refusing to push ${JSON.stringify(branch)} to GitHub: GitHub has a branch named ` +
    `${JSON.stringify(blocker)}, which is part of this deployment's branch namespace, and git ` +
    'cannot hold a branch inside another. Rename or delete that branch on GitHub.'
  )
}

/** Why a push of `branch` is refused while GitHub has `inside`, a branch inside it. */
export function branchInsideMessage(branch: string, inside: string): string {
  return (
    `Refusing to push ${JSON.stringify(branch)} to GitHub: GitHub has a branch named ` +
    `${JSON.stringify(inside)} inside it, and git cannot hold both. Rename or delete that ` +
    'branch on GitHub.'
  )
}

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
  if (pattern.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)) {
    return pattern.includes('*')
      ? `a glob never matches a settings branch, so one starting ${RESERVED_SETTINGS_BRANCH_PREFIX} matches nothing`
      : "a settings branch is pushed plainly every sync, so protecting it would stop this deployment's settings reaching GitHub"
  }
  return null
}

/**
 * Why `entry` cannot be a `legacyBranches` entry, whatever the namespace, or null. An entry is an
 * exact branch name git can push: a `*` would admit names no one listed, and one alone would
 * switch the namespace off. A comma separates entries in `CANOPYCMS_LEGACY_BRANCHES`. The CDK's
 * `assertValidLegacyBranches` holds a copy of these rules and the constructor's, both held to
 * worker/legacy-branch-fixtures.ts.
 * @internal Exported for tests.
 */
export function legacyBranchProblem(entry: string): string | null {
  if (entry.includes('*')) return 'an entry is an exact branch name, and * is not a wildcard here'
  if (entry.includes(',')) return 'it contains a comma, which separates entries'
  if (entry.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX)) {
    return 'it is a settings branch, which the gateway pushes without being listed'
  }
  const problem = protectedPatternProblem(entry)
  if (problem !== null) return problem
  if (entry === 'HEAD' || entry === '@') return `git reserves ${JSON.stringify(entry)}`
  if (entry.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return "a part of it starts with '.' or ends with '.lock', which git refuses"
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

/**
 * The most `protectedBranches` entries a policy takes. The wire answer lists them plus the base
 * branch (`describe()`), so its bound is one above this.
 */
export const MAX_PROTECTED_BRANCHES = 1024

/** The most `legacyBranches` entries a policy takes. */
export const MAX_LEGACY_BRANCHES = 1024

/**
 * The namespace a policy enforces when it is given none: the default template's, for the default
 * deployment name.
 * @internal Exported for tests.
 */
export const DEFAULT_BRANCH_NAMESPACE = resolveBranchNamespaceTemplate(
  DEFAULT_BRANCH_NAMESPACE_TEMPLATE,
  'prod',
  'the default',
)

export interface BranchPolicyOptions {
  /**
   * The namespace this gateway writes (`CANOPYCMS_BRANCH_NAMESPACE` resolved,
   * operating-mode/branch-namespace.ts). Default {@link DEFAULT_BRANCH_NAMESPACE}.
   */
  namespace?: string
  /** The configured base branch (`CANOPYCMS_BASE_BRANCH`); never one read from the workspace. */
  baseBranch?: string
  /** Further protected names and `*` globs (`CANOPYCMS_PROTECTED_BRANCHES`). */
  protectedBranches?: readonly string[]
  /**
   * This deployment's settings branch, the only one pushed. Without it no settings branch is.
   */
  settingsBranch?: string
  /**
   * Branches outside the namespace that may still be written: exact names, from before the
   * namespace (`CANOPYCMS_LEGACY_BRANCHES`).
   */
  legacyBranches?: readonly string[]
  /** Test seam: the clock {@link DEFAULT_BRANCH_TTL_MS} is measured on. */
  now?: () => number
}

/** What {@link BranchPolicy.describe} answers, which the gateway's health carries. */
export interface BranchPolicyDescription {
  /** The protected set's configured names and globs, the base branch included. */
  configured: string[]
  /** GitHub's default branch as last read; null before a read or for a repository with none. */
  githubDefault: string | null
  /** The namespace the gateway writes. */
  namespace: string
  legacy: string[]
  settingsBranch: string | null
}

/** Reads GitHub's default branch: null for a repository with none. */
export type DefaultBranchReader = () => Promise<string | null>

/**
 * The protected set, the namespace and the settings rules.
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
 * Nothing outside the namespace is written: a push, deletion or pull request head must start with
 * the namespace, be this deployment's settings branch, or be a `legacyBranches` entry, compared
 * exactly. Sanitized equivalence, right for the protected set where matching more refuses more,
 * would let an allow-list admit more. The protected set wins inside the namespace too. The
 * namespace comes from the gateway's own configuration, never a request. The base and settings
 * branches must lie outside it, by name and by workspace directory, and not be named after part of
 * it; a legacy entry inside it is refused as pointless, and one named after part of it as
 * blocking it.
 *
 * Settings branches are pushed plainly or not at all: no lease, no deletion, no pull request.
 * One is a name with the reserved prefix or this deployment's settings branch. Only this
 * deployment's is pushed: another deployment sharing the repository owns its own.
 */
export class BranchPolicy {
  private readonly exact: string[]
  private readonly globs: string[]
  /** The namespace the gateway writes. */
  readonly namespace: string
  private readonly settingsBranch: string | null
  private readonly legacy: ReadonlySet<string>
  private readonly now: () => number
  private githubDefault: { name: string | null; readAt: number } | null = null

  constructor(options: BranchPolicyOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.namespace = options.namespace ?? DEFAULT_BRANCH_NAMESPACE
    const namespaceProblem = branchNamespaceProblem(this.namespace)
    if (namespaceProblem !== null) {
      throw new Error(
        `Invalid branch namespace ${JSON.stringify(this.namespace)}: ${namespaceProblem}`,
      )
    }
    for (const [what, name] of [
      ['base branch', options.baseBranch],
      ['settings branch', options.settingsBranch],
    ] as const) {
      // Sanitized too: a workspace directory is the sanitized name, so `cms-prod-main` would share
      // one with `cms/prod/main`.
      if (
        name !== undefined &&
        (name.startsWith(this.namespace) ||
          sanitizeBranchName(name).startsWith(sanitizeBranchName(this.namespace)))
      ) {
        throw new Error(
          `The ${what} ${JSON.stringify(name)} is inside the branch namespace ${JSON.stringify(this.namespace)}, ` +
            'or shares a workspace directory with a branch in it, and the namespace holds only the ' +
            'branches editors create; choose a namespace it is outside',
        )
      }
      // git holds no ref under a path that is itself a branch.
      if (name !== undefined && this.namespace.startsWith(`${name}/`)) {
        throw new Error(
          `The ${what} ${JSON.stringify(name)} is a branch named after part of the branch namespace ` +
            `${JSON.stringify(this.namespace)}, so git can hold no branch in it; choose another namespace`,
        )
      }
    }
    const entries = [...(options.protectedBranches ?? [])]
    if (entries.length > MAX_PROTECTED_BRANCHES) {
      throw new Error(
        `protectedBranches has ${entries.length} entries; the most it takes is ${MAX_PROTECTED_BRANCHES}`,
      )
    }
    for (const entry of entries) {
      const problem = protectedPatternProblem(entry)
      if (problem !== null) {
        throw new Error(`Invalid protectedBranches entry ${JSON.stringify(entry)}: ${problem}`)
      }
    }
    if (options.baseBranch !== undefined) entries.push(options.baseBranch)
    this.exact = entries.filter((entry) => !entry.includes('*'))
    this.globs = entries.filter((entry) => entry.includes('*'))

    const settingsBranch = options.settingsBranch
    if (settingsBranch !== undefined) {
      const problem = branchNameProblem(settingsBranch)
      if (problem !== null) {
        throw new Error(`Invalid settings branch ${JSON.stringify(settingsBranch)}: ${problem}`)
      }
    }
    this.settingsBranch = settingsBranch ?? null

    const legacy = options.legacyBranches ?? []
    if (legacy.length > MAX_LEGACY_BRANCHES) {
      throw new Error(
        `legacyBranches has ${legacy.length} entries; the most it takes is ${MAX_LEGACY_BRANCHES}`,
      )
    }
    for (const entry of legacy) {
      const problem = entry.startsWith(this.namespace)
        ? `it starts with ${this.namespace}, so it is already in the namespace`
        : this.namespace.startsWith(`${entry}/`)
          ? `it is a branch named after part of the namespace ${this.namespace}, so git can hold no branch in it`
          : legacyBranchProblem(entry)
      if (problem !== null) {
        throw new Error(`Invalid legacyBranches entry ${JSON.stringify(entry)}: ${problem}`)
      }
    }
    if (new Set(legacy).size !== legacy.length) {
      throw new Error('legacyBranches lists a branch more than once')
    }
    this.legacy = new Set(legacy)
  }

  /** The policy as it stands. */
  describe(): BranchPolicyDescription {
    return {
      configured: [...this.exact, ...this.globs],
      githubDefault: this.githubDefault?.name ?? null,
      namespace: this.namespace,
      legacy: [...this.legacy],
      settingsBranch: this.settingsBranch,
    }
  }

  /** Whether `branch` is in the namespace itself, not merely writable as settings or legacy. */
  namespaceHolds(branch: string): boolean {
    return branch.startsWith(this.namespace)
  }

  /** Whether the gateway may write `branch` at all: the namespace, the settings branch, the list. */
  inNamespace(branch: string): boolean {
    return this.namespaceHolds(branch) || branch === this.settingsBranch || this.legacy.has(branch)
  }

  /**
   * The branch among `branches` named after part of the namespace, or null. While one exists git
   * holds no branch in the namespace, so the gateway refuses a push into it rather than send it.
   */
  namespaceBlocker(branches: { has(name: string): boolean }): string | null {
    return namespaceAncestors(this.namespace).find((name) => branches.has(name)) ?? null
  }

  /** Whether `branch` is protected; GitHub's default is read only when nothing else matches. */
  async isProtected(branch: string, readDefault: DefaultBranchReader): Promise<boolean> {
    if (this.matchesConfigured(branch)) return true
    const githubDefault = await this.githubDefaultBranch(readDefault)
    return githubDefault !== null && sameBranch(githubDefault, branch)
  }

  /**
   * Refuse a push to a protected branch, a leased push to a settings branch, a push to another
   * deployment's settings branch, and a push outside the namespace.
   */
  async assertPushAllowed(
    branch: string,
    lease: string | undefined,
    readDefault: DefaultBranchReader,
    refuse: (reason: PushPolicyRefusal, message: string) => Error,
  ): Promise<void> {
    const refusal = (reason: PushPolicyRefusal) =>
      refuse(reason, pushRefusalMessage(branch, reason, this.namespace))
    if (await this.isProtected(branch, readDefault)) throw refusal('protected')
    if (this.isSettings(branch)) {
      if (lease !== undefined) throw refusal('settings')
      if (branch !== this.settingsBranch) throw refusal('other-settings')
    }
    if (!this.inNamespace(branch)) throw refusal('outside-namespace')
  }

  /** Refuse to delete a protected branch, a settings branch, or one outside the namespace. */
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
    if (!this.inNamespace(branch)) {
      throw new GatewayRefusalError(
        'delete',
        branch,
        'outside-namespace',
        `${deleting(branch)}: ${outsideNamespaceWhy(this.namespace)}`,
      )
    }
  }

  /**
   * Refuse a pull request whose head is protected, a settings branch or outside the namespace, or
   * whose text is over its cap. The base is not restricted: a branch keeps the base it was created
   * from after the adopter moves theirs, and a pull request merges nothing by itself.
   */
  async assertPullRequestAllowed(
    request: { head: string; title?: string; body?: string },
    readDefault: DefaultBranchReader,
  ): Promise<void> {
    const { head } = request
    assertPullRequestText(openingFrom(head), head, request)
    await this.assertPullRequestHeadAllowed(openingFrom(head), head, readDefault)
  }

  /**
   * Refuse a pull request head the gateway may not open one from, or act on one with. `refusing`
   * opens the message and names `head`, which the rest calls "it".
   */
  async assertPullRequestHeadAllowed(
    refusing: string,
    head: string,
    readDefault: DefaultBranchReader,
  ): Promise<void> {
    if (this.isSettings(head)) {
      throw new GatewayRefusalError(
        'pull-request',
        head,
        'settings',
        `${refusing}: it is a settings branch, which never gets one`,
      )
    }
    if (await this.isProtected(head, readDefault)) {
      throw new GatewayRefusalError(
        'pull-request',
        head,
        'protected',
        `${refusing}: ${PROTECTED_WHY}`,
      )
    }
    if (!this.inNamespace(head)) {
      throw new GatewayRefusalError(
        'pull-request',
        head,
        'outside-namespace',
        `${refusing}: ${outsideNamespaceWhy(this.namespace)}`,
      )
    }
  }

  private isSettings(branch: string): boolean {
    return branch.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX) || branch === this.settingsBranch
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

/**
 * Whether the gateway that described its policy as `policy` would take a plain push of `branch`:
 * `BranchPolicy.assertPushAllowed`'s rules, for a reader that has only the description, with
 * GitHub's default as last read. A test holds the two equal.
 */
export function publishesBranch(policy: BranchPolicyDescription, branch: string): boolean {
  const settings =
    branch.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX) || branch === policy.settingsBranch
  const protectedMatch =
    policy.configured.some((entry) =>
      entry.includes('*')
        ? !settings && matchesBranchPattern(entry, branch)
        : sameBranch(entry, branch),
    ) ||
    (policy.githubDefault !== null && sameBranch(policy.githubDefault, branch))
  if (protectedMatch) return false
  if (settings) return branch === policy.settingsBranch
  return branch.startsWith(policy.namespace) || policy.legacy.includes(branch)
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
