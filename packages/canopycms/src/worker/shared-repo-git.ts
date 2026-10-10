import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git'

import { gitChildEnv } from '../git-manager'
import { getErrorMessage } from '../utils/error'

/**
 * How the worker runs git in a repository the CMS Lambda can also write: `remote.git` and every
 * branch clone on the shared filesystem. Their `.git/config` and hooks are Lambda-writable, and
 * the worker runs as the user that holds the GitHub credential, so git there must neither run
 * anything those files name nor reach anywhere they point. The credential itself never enters
 * these repositories; worker/github-mirror.ts holds it.
 *
 * Two layers. The `-c` pins below override repository config for every key they name, which
 * holds against a concurrent writer. Keys whose names the attacker chooses cannot be pinned
 * (`filter.<driver>.*`, `merge.<driver>.driver`, `url.<base>.insteadOf`, `http.<url>.*`), so
 * {@link assertSharedRepoConfig} refuses a repository whose own config holds anything outside
 * {@link ALLOWED_REPO_CONFIG_KEYS}. That check reads the config before git does, so a writer
 * that plants a driver between the two still runs code in a working-tree operation (rebase,
 * merge, checkout). Only moving that git into a process without the credential closes it:
 * .claude/future-tasks/worker-shared-repo-git-process-split.md.
 */

/**
 * Every hook event git 2.55 fires (githooks(5)). `hook.<event>.enabled=false` is what stops a
 * config-defined hook (`hook.<name>.command` + `.event`), which `core.hooksPath` does not; a git
 * without config hooks ignores the key.
 */
const HOOK_EVENTS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'post-index-change',
] as const

/**
 * Transports git can reach without a helper on PATH. A `protocol.<name>.allow` in repo config
 * outranks the generic `protocol.allow`, so each is pinned by name.
 */
const DENIED_TRANSPORTS = ['ext', 'fd', 'ssh', 'git', 'http', 'https', 'ftp', 'ftps'] as const

/**
 * `-c` settings for every worker git process in a shared repository, and for each process those
 * spawn: git passes them on through `GIT_CONFIG_PARAMETERS`, except to the `upload-pack` or
 * `receive-pack` of a local fetch or push, which {@link pinnedUploadPack} and
 * {@link pinnedReceivePack} pin on their own command line. Each entry is shell-safe, because
 * those two commands run through `sh -c`.
 */
const SHARED_REPO_PINS: readonly string[] = [
  'core.hooksPath=/dev/null',
  ...HOOK_EVENTS.map((event) => `hook.${event}.enabled=false`),
  'core.fsmonitor=false',
  // Advertising an alternate's refs runs this through the shell, or spawns git in the alternate
  // directory; the alternates file is Lambda-writable too.
  'core.alternateRefsCommand=true',
  'core.editor=true',
  'sequence.editor=true',
  'credential.helper=',
  'core.askPass=',
  'protocol.allow=never',
  'protocol.file.allow=always',
  ...DENIED_TRANSPORTS.map((transport) => `protocol.${transport}.allow=never`),
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'push.gpgSign=false',
  // A merge that verifies signatures runs the signing program on whatever signature a commit in
  // remote.git carries; the programs are pinned too, so nothing else that verifies runs one.
  'merge.verifySignatures=false',
  'pull.verifySignatures=false',
  'log.showSignature=false',
  'gpg.program=false',
  'gpg.ssh.program=false',
  'gpg.x509.program=false',
  // Negotiating a push runs the destination's upload-pack, unpinned.
  'push.negotiate=false',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'push.recurseSubmodules=no',
  'gc.auto=0',
  'maintenance.auto=false',
]

/** What a bare shared repository adds: never a working tree, so never a checkout. */
const BARE_PINS: readonly string[] = ['core.bare=true']

/**
 * What the worker's private GitHub mirror runs with (worker/github-mirror.ts). Nothing the Lambda
 * writes reaches that repository's config, so these are depth, not the boundary: the same pins,
 * HTTPS allowed for GitHub, and no credential helper ever handed the token. Objects from `remote.git`
 * are checked where they are fetched (worker/github-mirror.ts).
 */
const MIRROR_PINS: readonly string[] = [
  ...SHARED_REPO_PINS.filter((pin) => pin !== 'protocol.https.allow=never'),
  'protocol.https.allow=always',
  ...BARE_PINS,
]

/** simple-git refuses each of these pinned keys, and the pack-command options, unless opted in. */
const PIN_OPT_INS = {
  allowUnsafeHooksPath: true,
  allowUnsafeFsMonitor: true,
  allowUnsafeEditor: true,
  allowUnsafeCredentialHelper: true,
  allowUnsafeAskPass: true,
  allowUnsafeProtocolOverride: true,
  allowUnsafeGpgProgram: true,
  allowUnsafePack: true,
} as const

export type SharedRepoKind = 'bare' | 'worktree'

function pinsFor(kind: SharedRepoKind): string[] {
  return kind === 'bare' ? [...SHARED_REPO_PINS, ...BARE_PINS] : [...SHARED_REPO_PINS]
}

/**
 * simple-git options for a worker git instance in a shared repository. Only for a call that names
 * the repository itself with `--git-dir`; everything else uses {@link sharedRepoGit}.
 */
export function sharedRepoGitOptions(
  kind: SharedRepoKind,
): Pick<SimpleGitOptions, 'config' | 'unsafe'> {
  return { config: pinsFor(kind), unsafe: { ...PIN_OPT_INS } }
}

/** The git directory of a shared repository: itself when bare, its `.git` otherwise. */
function gitDirOf(repoPath: string, kind: SharedRepoKind): string {
  return kind === 'bare' ? repoPath : path.join(repoPath, '.git')
}

/**
 * A worker git instance in the shared repository at `repoPath` (the bare repository itself, or a
 * clone's working tree), with the pins applied. The repository is named outright, as
 * {@link assertSharedRepoConfig} names it, so both read the same config: discovery would take a
 * planted `remote.git/.git`, or a `.git` above a clone whose own was removed. A clone's working
 * tree is named too, which also overrides `core.worktree`.
 *
 * `options` are the caller's own (`timeout`, `abort`), applied under the pins. The child env is
 * `gitChildEnv`'s: every shared-repository operation is local.
 */
export function sharedRepoGit(
  repoPath: string,
  kind: SharedRepoKind,
  options: Partial<SimpleGitOptions> = {},
): SimpleGit {
  const absolute = path.resolve(repoPath)
  return simpleGit({ ...options, baseDir: absolute, ...sharedRepoGitOptions(kind) }).env(
    gitChildEnv({
      GIT_DIR: gitDirOf(absolute, kind),
      ...(kind === 'worktree' ? { GIT_WORK_TREE: absolute } : {}),
      // A missing object would otherwise be fetched from a promisor remote the config names, by
      // that remote's own upload-pack command (git 2.45+; older git ignores it).
      GIT_NO_LAZY_FETCH: '1',
    }),
  )
}

/** simple-git options for the worker's private GitHub mirror. */
export function mirrorGitOptions(): Pick<SimpleGitOptions, 'config' | 'unsafe'> {
  return { config: [...MIRROR_PINS], unsafe: { ...PIN_OPT_INS } }
}

function packCommand(
  program: string,
  extra: readonly string[],
  flags: readonly string[] = [],
): string {
  return [
    'git',
    ...[...pinsFor('bare'), ...extra].flatMap((pin) => ['-c', pin]),
    program,
    ...flags,
  ].join(' ')
}

/**
 * `--upload-pack` for a fetch FROM `remote.git`. Wants by object ID are allowed so a caller can
 * fetch exactly the commit it read, rather than whatever the ref points at by then.
 */
export function pinnedUploadPack(): string {
  // --strict: never `<path>/.git` in place of the repository named.
  return packCommand('upload-pack', ['uploadpack.allowAnySHA1InWant=true'], ['--strict'])
}

/**
 * `--receive-pack` for a push INTO `remote.git`. Without it the push runs remote.git's own hooks
 * as the worker. The `receive.deny*` pins keep a planted setting from blocking the forced update
 * of the GitHub tracking refs.
 */
export function pinnedReceivePack(): string {
  return packCommand('receive-pack', [
    'receive.autogc=false',
    'receive.denyDeletes=false',
    'receive.denyNonFastForwards=false',
  ])
}

/**
 * Fetch `branch` from `remote.git` into the clone `git` runs in, through
 * {@link pinnedUploadPack}. The result is in FETCH_HEAD only.
 */
export async function fetchFromRemoteGit(
  git: SimpleGit,
  remoteGitPath: string,
  branch: string,
): Promise<void> {
  await git.raw([
    'fetch',
    `--upload-pack=${pinnedUploadPack()}`,
    '--end-of-options',
    remoteGitPath,
    branch,
  ])
}

/**
 * Repository config keys CanopyCMS or git itself writes into a shared repository, in the form
 * `git config --list` prints them (section and key lowercased, subsection verbatim). Covers every
 * writer in this repository's history: clone (`core.*`, `remote.*`, `branch.*`, plus the `-c`
 * settings it persists: `managedWorkspaceConfig`'s and gc's), `ensureAuthor`, `ensureRemote`,
 * `push --set-upstream`, `sparse-checkout set` (`extensions.worktreeConfig` and the cone keys in
 * `config.worktree`), `REMOTE_GIT_CONFIG`, and the `remote.origin.url` a pre-scrub bare clone of
 * GitHub left in `remote.git`. A named remote's `url` is inert here because the worker addresses
 * remotes by path, and the transport pins hold whatever it says.
 */
const ALLOWED_REPO_CONFIG_KEYS: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|sparsecheckout|sparsecheckoutcone)$/,
  /^extensions\.(worktreeconfig|objectformat|refstorage)$/,
  /^index\.sparse$/,
  /^remote\..+\.(url|fetch)$/,
  /^branch\..+\.(remote|merge)$/,
  /^user\.(name|email)$/,
  /^canopycms\.managed$/,
  /^gc\.auto$/,
  /^maintenance\.auto$/,
  /^receive\.autogc$/,
  /^transfer\.unpacklimit$/,
]

/** @internal Exported for tests. */
export interface UnexpectedConfigKey {
  key: string
  /** The file git read it from, absolute. */
  file: string
}

/**
 * A shared repository whose own config holds a key CanopyCMS never writes.
 * @internal Exported for tests.
 */
export class UntrustedRepoConfigError extends Error {
  constructor(
    readonly repoPath: string,
    readonly keys: readonly UnexpectedConfigKey[],
  ) {
    // Keys and files only: a value can be a credential.
    super(
      `Refusing to run git in ${repoPath}: its git config holds ` +
        `${keys.length === 1 ? 'a setting' : `${keys.length} settings`} CanopyCMS never writes, ` +
        `which can make the worker run a command or send its GitHub credential elsewhere ` +
        `(${keys.map((k) => `${k.key} in ${k.file}`).join('; ')}). Find out how ` +
        `${keys.length === 1 ? 'it' : 'they'} got there, then remove ` +
        `${keys.length === 1 ? 'it' : 'them'}: ` +
        keys
          .map((k) => `git config --file ${shellQuote(k.file)} --unset-all ${shellQuote(k.key)}`)
          .join(' && '),
    )
    this.name = 'UntrustedRepoConfigError'
  }
}

async function pathExists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  )
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Scopes the repository itself supplies; `system`, `global` and `command` are the worker's. */
const REPO_SCOPES = new Set(['local', 'worktree'])

/**
 * Refuse a shared repository whose own config (with its includes, and `config.worktree`) holds a
 * key outside {@link ALLOWED_REPO_CONFIG_KEYS}. Throws {@link UntrustedRepoConfigError}. A config
 * git cannot read is also refused, with git's own message, which names a bad line but not its
 * content.
 *
 * `repoPath` is the bare repository itself for `bare`, the working tree for `worktree`.
 */
export async function assertSharedRepoConfig(
  repoPath: string,
  kind: SharedRepoKind,
): Promise<void> {
  const absolute = path.resolve(repoPath)
  const gitDir = gitDirOf(absolute, kind)
  let listing: string
  try {
    // `git config --list` runs outside a repository too, reading no repository config at all. A
    // symlink, or a `commondir` file, would aim the operation at another repository, such as the
    // worker's own mirror.
    for (const entry of kind === 'bare' ? [gitDir] : [absolute, gitDir]) {
      const stat = await fs.lstat(entry)
      if (!stat.isDirectory()) throw new Error(`${entry} is not a directory`)
    }
    if (await pathExists(path.join(gitDir, 'commondir'))) {
      throw new Error(
        `${path.join(gitDir, 'commondir')} exists, and git would use another repository`,
      )
    }
    // receive-pack, given a bare repository's path, uses `<path>/.git` when there is one.
    if (kind === 'bare' && (await pathExists(path.join(gitDir, '.git')))) {
      throw new Error(`${path.join(gitDir, '.git')} exists, and git would use it instead`)
    }
    listing = await sharedRepoGit(absolute, kind).raw([
      'config',
      '--list',
      '--show-scope',
      '--show-origin',
      '-z',
    ])
  } catch (err: unknown) {
    throw new UntrustedRepoConfigError(absolute, [
      { key: `(unreadable: ${getErrorMessage(err).trim()})`, file: path.join(gitDir, 'config') },
    ])
  }

  const unexpected: UnexpectedConfigKey[] = []
  // -z prints each entry as `scope NUL origin NUL key LF value NUL`.
  const fields = listing.split('\0')
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [scope, origin, entry] = [fields[i], fields[i + 1], fields[i + 2]]
    if (!REPO_SCOPES.has(scope)) continue
    const newline = entry.indexOf('\n')
    const key = newline === -1 ? entry : entry.slice(0, newline)
    if (ALLOWED_REPO_CONFIG_KEYS.some((allowed) => allowed.test(key))) continue
    const file = origin.startsWith('file:') ? origin.slice('file:'.length) : origin
    unexpected.push({ key, file })
  }
  if (unexpected.length > 0) throw new UntrustedRepoConfigError(absolute, unexpected)
}
