/**
 * Crash-safe provisioning of content-branch workspaces.
 *
 * [PROV-1] A final branch directory only ever appears by `rename()`, with
 * `.canopy-meta/branch.json` already inside it. A Lambda can be killed at its
 * timeout inside any git step, and anything it was building at the final path
 * would wedge that branch name for every later request. So a workspace is built
 * in a dot-prefixed staging sibling without any lock (the registry,
 * branch-health, the rebase loop and admin all skip dot-prefixed names), then
 * published by one rename under the branch's provisioning lock, held for
 * milliseconds. A kill at any point leaves nothing at the final name or a
 * complete workspace; the worker sweeps the leftovers.
 *
 * The rename alone does not settle a race: it silently replaces an EMPTY
 * directory, and a refused rename may be blocked by a live branch or by
 * residue. Hence the lock, and the inspection of whatever blocks the rename.
 * docs/concurrency.md has the cross-host picture.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  BRANCH_META_DIR,
  BRANCH_META_FILE,
  BranchMetadataCorruptError,
  readBranchMetadataFile,
  type BranchMetadataFile,
} from './branch-metadata-file'
import { GitManager, type CloneRepoOptions } from './git-manager'
import { sanitizeBranchName } from './paths/branch-name'
import { getErrorMessage, isNodeError, isNotFoundError } from './utils/error'
import { isNetworkRemoteUrl } from './utils/git'
import { canopyLogError, canopyLogWarn } from './utils/logger'
import { writeOccJsonFile } from './utils/occ-json-write'
import type { ProvisionLog } from './utils/provision-log'
import {
  acquireProvisioningLockWithin,
  branchProvisioningLockName,
  tryAcquireProvisioningLock,
} from './utils/provisioning-lock'

/**
 * How long a publish waits for the branch's provisioning lock. Holds on a name being published
 * are brief; a dead holder's marker stays live for 90 s, and waiting that out would spend the
 * request's timeout.
 */
const PUBLISH_LOCK_WAIT_MS = 8_000

/** How long residue must have been untouched before a create request moves it aside. */
export const CREATE_RESIDUE_MIN_QUIET_MS = 60_000

/**
 * Stamped leftovers older than these are swept by the worker. A `.prov-*` may belong to a live
 * builder for as long as a Lambda can run (900 s at most, whatever timeout an adopter sets).
 */
const STAGING_MAX_AGE_MS = 20 * 60_000
const REPAIR_MAX_AGE_MS = 20 * 60_000
const DELETING_MAX_AGE_MS = 10 * 60_000
const SETTINGS_TRASH_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/**
 * Retriable: another process is setting this branch up, or what is at its path is too recently
 * touched (or under an admin repair) to judge. Callers answer 503.
 */
export class BranchProvisioningBusyError extends Error {
  constructor(
    readonly dirName: string,
    message = `Branch '${dirName}' is still being set up. Try again in a minute.`,
  ) {
    super(message)
    this.name = 'BranchProvisioningBusyError'
  }
}

/** The branch's path holds a git repository this deployment did not create (prod only). */
export class BranchDirOccupiedError extends Error {
  constructor(readonly dirName: string) {
    super(
      `A directory named '${dirName}' already exists in the branch workspace and holds a git ` +
        `repository this deployment did not create. It was left untouched; an admin can purge ` +
        `it from System Health, or choose another branch name.`,
    )
    this.name = 'BranchDirOccupiedError'
  }
}

// --- Names -----------------------------------------------------------------------------------

const DIR_STAMP_RE = /-(\d{8}T\d{6}Z)$/

/** `YYYYMMDDTHHMMSSZ` in UTC, with no colons. */
export function formatDirStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

/**
 * The date in a name ending `-{STAMP}`, or null. Leftovers are aged by this alone, never by
 * mtime: `rename()` keeps a directory's mtime, so a months-old residue would look old the
 * moment it was moved.
 */
export function parseDirStamp(name: string): Date | null {
  const match = DIR_STAMP_RE.exec(name)
  if (!match) return null
  const [, year, month, day, hour, minute, second] =
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(match[1]) ?? []
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * A branch directory name cut to a bounded, still-unique form: branch names run to 250 chars.
 * @internal Exported for tests.
 */
export function shortDirName(dirName: string): string {
  const digest = createHash('sha1').update(dirName).digest('hex').slice(0, 10)
  return `${dirName.slice(0, 40)}-${digest}`
}

function stampedName(prefix: string, dirName: string, now: Date): string {
  return `${prefix}${shortDirName(dirName)}-${randomBytes(3).toString('hex')}-${formatDirStamp(now)}`
}

const STAGING_PREFIX = '.prov-'
const REPAIR_PREFIX = '.repair-'
const TRASH_PREFIX = '.trash-'
const DELETING_PREFIX = '.deleting-'

/** Where a branch is built before it is published. */
const stagingDirName = (dirName: string, now = new Date()): string =>
  stampedName(STAGING_PREFIX, dirName, now)

/** Where a branch directory goes the moment it is deleted, before its `rm`. */
export const deletingDirName = (dirName: string, now = new Date()): string =>
  stampedName(DELETING_PREFIX, dirName, now)

/** The settings workspace's staging and trash siblings, under the workspace root. */
export const settingsStagingDirName = (now = new Date()): string =>
  `${STAGING_PREFIX}settings-${randomBytes(3).toString('hex')}-${formatDirStamp(now)}`
export const settingsTrashDirName = (now = new Date()): string =>
  `${TRASH_PREFIX}settings-${randomBytes(3).toString('hex')}-${formatDirStamp(now)}`

// --- Inspecting a branch path -----------------------------------------------------------------

interface ResidueSignature {
  hasGitDir: boolean
  configLock: boolean
  hasIndex: boolean
}

/**
 * What occupies a branch's final path.
 *
 * - `live` / `corrupt`: branch.json is there. Never touched by provisioning.
 * - `protected`: an admin repair-metadata is mid-way (`branch.json.corrupt-*` with no
 *   branch.json), or branch.json vanished between the listing and the read. Left alone.
 * - `residue`: nothing this deployment could still be using — no `.git`, or a `.git` whose config
 *   is missing or unreadable (an interrupted clone), or one whose remote is this deployment's own
 *   (an interrupted clone or delete).
 * - `foreign`: any other repository, such as a dev CLI-sync workspace, which has no remote.
 */
export type FinalDirState =
  | { kind: 'vacant' }
  | { kind: 'live' }
  | { kind: 'corrupt' }
  | { kind: 'protected' }
  | { kind: 'foreign' }
  | { kind: 'residue'; signature: ResidueSignature }

const NO_GIT: ResidueSignature = { hasGitDir: false, configLock: false, hasIndex: false }

async function listDir(dirPath: string): Promise<string[] | null> {
  try {
    return await fs.readdir(dirPath)
  } catch (err: unknown) {
    if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null
    throw err
  }
}

/** Remote URLs in a git config file's text. Read as a file because git refuses to run while a
 * stale `config.lock` is present. */
function gitConfigRemoteUrls(text: string): string[] {
  const urls: string[] = []
  let inRemote = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inRemote = /^\[\s*remote\s+"[^"]*"\s*\]/i.test(line)
      continue
    }
    const match = inRemote ? /^url\s*=\s*(.*)$/i.exec(line) : null
    if (match) urls.push(match[1].trim().replace(/^"(.*)"$/, '$1'))
  }
  return urls
}

function sameRemote(url: string, expected: string): boolean {
  if (isNetworkRemoteUrl(url) || isNetworkRemoteUrl(expected)) return url === expected
  const local = (value: string) => path.resolve(value.replace(/^file:\/\//i, ''))
  return local(url) === local(expected)
}

/** Classify what is at `dirPath`; see {@link FinalDirState}. */
export async function classifyFinalDir(
  dirPath: string,
  expectedRemoteUrl: string,
): Promise<FinalDirState> {
  let stat
  try {
    stat = await fs.lstat(dirPath)
  } catch (err: unknown) {
    if (isNotFoundError(err)) return { kind: 'vacant' }
    throw err
  }
  if (!stat.isDirectory()) return { kind: 'residue', signature: NO_GIT }

  const metaEntries = (await listDir(path.join(dirPath, BRANCH_META_DIR))) ?? []
  if (metaEntries.includes(BRANCH_META_FILE)) {
    try {
      return (await readBranchMetadataFile(dirPath)) ? { kind: 'live' } : { kind: 'protected' }
    } catch (err: unknown) {
      if (err instanceof BranchMetadataCorruptError) return { kind: 'corrupt' }
      throw err
    }
  }
  if (metaEntries.some((name) => name.startsWith(`${BRANCH_META_FILE}.corrupt-`))) {
    return { kind: 'protected' }
  }

  const gitPath = path.join(dirPath, '.git')
  let gitStat
  try {
    gitStat = await fs.lstat(gitPath)
  } catch (err: unknown) {
    if (isNotFoundError(err)) return { kind: 'residue', signature: NO_GIT }
    throw err
  }
  if (!gitStat.isDirectory()) return { kind: 'foreign' }

  const gitEntries = (await listDir(gitPath)) ?? []
  const signature: ResidueSignature = {
    hasGitDir: true,
    configLock: gitEntries.includes('config.lock'),
    hasIndex: gitEntries.includes('index'),
  }
  let config: string
  try {
    config = await fs.readFile(path.join(gitPath, 'config'), 'utf8')
  } catch {
    return { kind: 'residue', signature }
  }
  return gitConfigRemoteUrls(config).some((url) => sameRemote(url, expectedRemoteUrl))
    ? { kind: 'residue', signature }
    : { kind: 'foreign' }
}

/**
 * Milliseconds since anything was last created or removed in the directory, its `.git` or its
 * `.canopy-meta`. A clone killed inside `git config` touched `.git` when it made `config.lock`.
 */
export async function quietAgeMs(dirPath: string, now = Date.now()): Promise<number> {
  const mtimes = await Promise.all(
    ['', '.git', BRANCH_META_DIR].map((sub) =>
      fs.lstat(path.join(dirPath, sub)).then(
        (stat) => stat.mtimeMs,
        () => 0,
      ),
    ),
  )
  return now - Math.max(...mtimes)
}

// --- Quarantine -------------------------------------------------------------------------------

export type QuarantineResult =
  | { kind: 'quarantined'; trashName: string }
  | { kind: 'vacant' }
  | {
      kind: 'kept'
      reason: 'live' | 'corrupt' | 'protected' | 'foreign' | 'too-young' | 'replaced'
    }

export interface QuarantineOptions {
  minQuietMs: number
  expectedRemoteUrl: string
  now?: number
}

/**
 * Move residue at `baseRoot/dirName` to `.trash-*`. The caller MUST hold the branch's
 * provisioning lock: admin repair-metadata holds it while it legitimately leaves a directory
 * with real edits and no branch.json.
 *
 * Move-then-verify: the name is renamed aside first and only what arrived at the new name is
 * judged — the same inode the old name showed, still residue, quiet for `minQuietMs` — because
 * a look through the old name can come from a stale NFS dentry for a directory another host has
 * since replaced with a live clone. Anything that fails a check is renamed straight back.
 */
export async function quarantineResidueAt(
  baseRoot: string,
  dirName: string,
  options: QuarantineOptions,
): Promise<QuarantineResult> {
  const finalPath = path.join(baseRoot, dirName)
  let inode: number
  try {
    inode = (await fs.lstat(finalPath)).ino
  } catch (err: unknown) {
    if (isNotFoundError(err)) return { kind: 'vacant' }
    throw err
  }

  const candidateName = stampedName(REPAIR_PREFIX, dirName, new Date())
  const candidate = path.join(baseRoot, candidateName)
  try {
    await fs.rename(finalPath, candidate)
  } catch (err: unknown) {
    if (isNotFoundError(err)) return { kind: 'vacant' }
    throw err
  }

  const state = await classifyFinalDir(candidate, options.expectedRemoteUrl)
  const moved = await fs.lstat(candidate).catch(() => null)
  const quiet = await quietAgeMs(candidate, options.now)
  let reason: Extract<QuarantineResult, { kind: 'kept' }>['reason'] | undefined
  if (!moved || moved.ino !== inode) reason = 'replaced'
  else if (state.kind === 'vacant') reason = 'replaced'
  else if (state.kind !== 'residue') reason = state.kind
  else if (quiet < options.minQuietMs) reason = 'too-young'

  if (reason === undefined && state.kind === 'residue') {
    const trashName = stampedName(TRASH_PREFIX, dirName, new Date())
    await fs.rename(candidate, path.join(baseRoot, trashName))
    const { hasGitDir, configLock, hasIndex } = state.signature
    canopyLogWarn(
      `[canopy] Quarantined unfinished branch directory '${dirName}' as ${trashName} ` +
        `(git=${hasGitDir} config.lock=${configLock} index=${hasIndex} quiet=${Math.round(quiet / 1000)}s)`,
    )
    return { kind: 'quarantined', trashName }
  }

  try {
    await fs.rename(candidate, finalPath)
  } catch (err: unknown) {
    canopyLogError(
      `[canopy] Could not move '${dirName}' back from ${candidateName} after declining to ` +
        `quarantine it (${reason}): ${getErrorMessage(err)}. The worker's sweep recovers it.`,
    )
  }
  return { kind: 'kept', reason: reason ?? 'replaced' }
}

// --- Build and publish ------------------------------------------------------------------------

/** Runs between the no-checkout clone and its checkout. */
type PrepareCheckout = (git: GitManager, stagingPath: string) => Promise<void>

export interface StageBranchOptions {
  baseRoot: string
  dirName: string
  branchName: string
  baseBranch: string
  remoteUrl: string
  clone: Pick<CloneRepoOptions, 'remoteName' | 'config'>
  gitExcludePattern: string
  metadata: BranchMetadataFile
  provisionLog: ProvisionLog
  prepareCheckout?: PrepareCheckout
}

export type StageResult =
  | { kind: 'staged'; stagingPath: string; meta: BranchMetadataFile }
  | { kind: 'exists' }

/** Remove a staging or deleted directory, leaving it to the worker's sweep on failure. */
export async function removeLeftoverDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (err: unknown) {
    canopyLogWarn(
      `[canopy] Could not remove ${dirPath}; the worker sweeps it: ${getErrorMessage(err)}`,
    )
  }
}

async function hasBranchMetadata(branchRoot: string): Promise<boolean> {
  return fs.access(path.join(branchRoot, BRANCH_META_DIR, BRANCH_META_FILE)).then(
    () => true,
    () => false,
  )
}

/**
 * Build a complete branch workspace, branch.json included, in a staging sibling of the final
 * path. Takes no lock. Returns `exists` without checking out when a competitor published first.
 * A failure removes the staging directory; a kill leaves it for the worker.
 */
export async function stageBranchWorkspace(options: StageBranchOptions): Promise<StageResult> {
  const { provisionLog: log } = options
  const stagingPath = path.join(options.baseRoot, stagingDirName(options.dirName))
  try {
    await log.step('clone', () =>
      GitManager.cloneWorkspace(options.remoteUrl, stagingPath, options.baseBranch, {
        ...options.clone,
        noCheckout: true,
      }),
    )
    const git = new GitManager({
      repoPath: stagingPath,
      baseBranch: options.baseBranch,
      remote: options.clone.remoteName,
    })
    const prepare = options.prepareCheckout
    if (prepare) await log.step('prepare', () => prepare(git, stagingPath))

    // The checkout is the expensive half; skip it when a competitor has already won.
    if (await hasBranchMetadata(path.join(options.baseRoot, options.dirName))) {
      await removeLeftoverDir(stagingPath)
      return { kind: 'exists' }
    }
    await log.step('checkout', () => git.checkoutFreshClone(options.branchName))
    await log.step('exclude', () => git.ensureGitExclude(options.gitExcludePattern))
    const written = await log.step('metadata', () =>
      writeOccJsonFile(
        path.join(stagingPath, BRANCH_META_DIR, BRANCH_META_FILE),
        { ...options.metadata },
        { expectedVersion: null, trailingNewline: true },
      ),
    )
    return {
      kind: 'staged',
      stagingPath,
      meta: { ...options.metadata, version: written.version, writeId: written.writeId },
    }
  } catch (err) {
    await removeLeftoverDir(stagingPath)
    throw err
  }
}

/**
 * The branch's provisioning lock with a bounded wait; contention is
 * {@link BranchProvisioningBusyError}.
 */
export async function lockBranchName(
  baseRoot: string,
  dirName: string,
): Promise<() => Promise<void>> {
  try {
    return await acquireProvisioningLockWithin(
      baseRoot,
      branchProvisioningLockName(dirName),
      PUBLISH_LOCK_WAIT_MS,
    )
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ELOCKED') throw new BranchProvisioningBusyError(dirName)
    throw err
  }
}

/** What blocks a refused publish rename, as {@link publishStaging} sees it. */
export type BlockingKind = 'live' | 'protected' | 'residue'

export interface PublishOptions {
  baseRoot: string
  dirName: string
  stagingPath: string
  /** branch.json's `writeId` in the staged workspace: proof the rename was ours. */
  writeId: string | undefined
  expectedRemoteUrl: string
  /** Test seam replacing the look at what blocks a refused rename. */
  inspectBlocked?: (finalPath: string) => Promise<BlockingKind>
}

/** Listing `.canopy-meta` opens the directory, which makes NFS revalidate it. */
async function inspectBlocking(finalPath: string): Promise<BlockingKind> {
  const entries = (await listDir(path.join(finalPath, BRANCH_META_DIR))) ?? []
  if (entries.includes(BRANCH_META_FILE)) return 'live'
  if (entries.some((name) => name.startsWith(`${BRANCH_META_FILE}.corrupt-`))) return 'protected'
  return 'residue'
}

const RENAME_BLOCKED = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR'])

/**
 * Publish a staged workspace at its final path, under the branch's provisioning lock.
 *
 * A refused rename is inspected: branch.json there means another request won (`exists`);
 * residue is quarantined and the rename retried once. ENOENT can be an NFS retransmission of a
 * rename that already landed, so it counts as published when the final branch.json carries our
 * `writeId`. The caller removes the staging directory on any outcome but `published`.
 */
export async function publishStaging(options: PublishOptions): Promise<'published' | 'exists'> {
  const { baseRoot, dirName, stagingPath } = options
  const finalPath = path.join(baseRoot, dirName)
  const release = await lockBranchName(baseRoot, dirName)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.rename(stagingPath, finalPath)
        return 'published'
      } catch (err: unknown) {
        if (!isNodeError(err)) throw err
        if (err.code === 'ENOENT') {
          const meta = await readBranchMetadataFile(finalPath).catch(() => null)
          if (meta?.writeId !== undefined && meta.writeId === options.writeId) return 'published'
          throw err
        }
        if (!RENAME_BLOCKED.has(err.code ?? '')) throw err
      }

      const blocking = await (options.inspectBlocked ?? inspectBlocking)(finalPath)
      if (blocking === 'live') return 'exists'
      if (blocking === 'protected') throw new BranchProvisioningBusyError(dirName)
      const result = await quarantineResidueAt(baseRoot, dirName, {
        minQuietMs: CREATE_RESIDUE_MIN_QUIET_MS,
        expectedRemoteUrl: options.expectedRemoteUrl,
      })
      if (result.kind !== 'kept') continue
      if (result.reason === 'live') return 'exists'
      if (result.reason === 'corrupt') {
        await readBranchMetadataFile(finalPath)
        return 'exists'
      }
      if (result.reason === 'foreign') throw new BranchDirOccupiedError(dirName)
      throw new BranchProvisioningBusyError(dirName)
    }
    throw new BranchProvisioningBusyError(dirName)
  } finally {
    await release().catch((err: unknown) => {
      canopyLogWarn(`[canopy] Failed to release the provisioning lock for ${dirName}:`, err)
    })
  }
}

// --- Worker sweep -----------------------------------------------------------------------------

export interface LeftoverAction {
  name: string
  action: 'removed' | 'restored' | 'trashed' | 'failed'
  detail?: string
}

async function sweepByAge(
  root: string,
  rules: readonly { prefix: string; maxAgeMs: number }[],
  now: number,
): Promise<LeftoverAction[]> {
  const entries = (await listDir(root)) ?? []
  const actions: LeftoverAction[] = []
  for (const name of entries) {
    const rule = rules.find((candidate) => name.startsWith(candidate.prefix))
    const stamp = rule ? parseDirStamp(name) : null
    if (!rule || !stamp || now - stamp.getTime() < rule.maxAgeMs) continue
    try {
      await fs.rm(path.join(root, name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
      actions.push({ name, action: 'removed' })
    } catch (err: unknown) {
      actions.push({ name, action: 'failed', detail: getErrorMessage(err) })
    }
  }
  return actions
}

/**
 * A `.repair-*` left by a process killed mid-quarantine goes back to its branch name when it
 * holds branch.json and the name is free; anything else is trashed. The branch name comes from
 * its branch.json, checked against the name's bounded prefix.
 */
async function recoverRepairDir(baseRoot: string, name: string): Promise<LeftoverAction> {
  const repairPath = path.join(baseRoot, name)
  const meta = await readBranchMetadataFile(repairPath).catch(() => null)
  const dirName = meta ? sanitizeBranchName(meta.branch.name) : undefined
  if (dirName && name.startsWith(`${REPAIR_PREFIX}${shortDirName(dirName)}-`)) {
    let release: (() => Promise<void>) | undefined
    try {
      release = await tryAcquireProvisioningLock(baseRoot, branchProvisioningLockName(dirName))
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ELOCKED') {
        return { name, action: 'failed', detail: 'provisioning lock held; retrying next cycle' }
      }
      throw err
    }
    try {
      const finalPath = path.join(baseRoot, dirName)
      if ((await fs.lstat(finalPath).catch(() => null)) === null) {
        await fs.rename(repairPath, finalPath)
        return { name, action: 'restored', detail: dirName }
      }
    } finally {
      await release().catch(() => {})
    }
  }
  const trashName = `${TRASH_PREFIX}${name.slice(REPAIR_PREFIX.length)}`
  await fs.rename(repairPath, path.join(baseRoot, trashName))
  return { name, action: 'trashed', detail: trashName }
}

/**
 * Clear what killed processes left beside the branch directories (`baseRoot`) and the settings
 * workspace (`workspaceRoot`): stale `.prov-*` builds, `.deleting-*` directories whose `rm` never
 * finished, `.repair-*` from an interrupted quarantine, and expired settings trash. Ages come
 * from the stamp in each name.
 */
export async function sweepProvisioningLeftovers(
  baseRoot: string,
  workspaceRoot: string,
  now = Date.now(),
): Promise<LeftoverAction[]> {
  const actions = await sweepByAge(
    baseRoot,
    [
      { prefix: STAGING_PREFIX, maxAgeMs: STAGING_MAX_AGE_MS },
      { prefix: DELETING_PREFIX, maxAgeMs: DELETING_MAX_AGE_MS },
    ],
    now,
  )
  for (const name of (await listDir(baseRoot)) ?? []) {
    const stamp = name.startsWith(REPAIR_PREFIX) ? parseDirStamp(name) : null
    if (!stamp || now - stamp.getTime() < REPAIR_MAX_AGE_MS) continue
    try {
      actions.push(await recoverRepairDir(baseRoot, name))
    } catch (err: unknown) {
      actions.push({ name, action: 'failed', detail: getErrorMessage(err) })
    }
  }
  actions.push(
    ...(await sweepByAge(
      workspaceRoot,
      [
        { prefix: `${STAGING_PREFIX}settings-`, maxAgeMs: STAGING_MAX_AGE_MS },
        { prefix: `${TRASH_PREFIX}settings-`, maxAgeMs: SETTINGS_TRASH_MAX_AGE_MS },
      ],
      now,
    )),
  )
  return actions
}
