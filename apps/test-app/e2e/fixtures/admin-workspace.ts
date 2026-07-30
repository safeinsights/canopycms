/**
 * Fixtures for the admin observability + recovery surfaces (System health panel).
 *
 * These surfaces read filesystem state that, in a real deployment, only the
 * CmsWorker daemon writes: the task queue under `.tasks/`, the `.worker-lock`
 * heartbeat directory, `worker-status.json`, and per-branch-directory health.
 * **No worker runs in dev mode**, so an e2e test has to seed that state
 * directly — the same technique `test-workspace.ts` already uses for git state
 * (`commitBranchChanges`, `pushConflictingChangeToMain`), extended to the
 * task-queue and branch-directory files.
 *
 * Seeding on disk rather than adding server endpoints keeps the production
 * request surface unchanged: there is exactly one test-only route in the app
 * (`/api/e2e-test/rebase`) and this file deliberately does not add more.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Task, TaskStatus } from '../../../../packages/canopycms/src/task-queue/types'
import type { BranchMetadata, WorkerStatusReport } from '../../../../packages/canopycms/src/types'
// Static import (not a dynamic `await import(...)`): a dynamic import of this
// raw .ts source path gets resolved through Node's own ESM loader rather
// than Playwright's test transform, which throws "exports is not defined in
// ES module scope" the moment the target module's compiled output touches
// `exports`. `test-workspace.ts` already imports this the normal way -- match
// that working precedent instead of routing through `import()`.
import { bumpResourceGeneration } from '../../../../packages/canopycms/src/resource-generation'

const TEST_APP_ROOT = path.resolve(process.cwd(), 'apps/test-app')

/**
 * Dev-mode task queue directory. Mirrors `getTaskQueueDir({mode:'dev'})`
 * (`{cwd}/.canopy-dev/.tasks`) — the dev server runs with cwd = apps/test-app,
 * while these fixtures run from the repo root, hence the explicit join.
 */
const TASKS_DIR = path.join(TEST_APP_ROOT, '.canopy-dev/.tasks')
const BRANCHES_DIR = path.join(TEST_APP_ROOT, '.canopy-dev/content-branches')

/** Every subdirectory the task queue uses. `corrupt/` holds unparseable files. */
const TASK_DIRS = ['pending', 'processing', 'completed', 'failed', 'corrupt'] as const

/** Queue buckets a Task JSON file can be seeded into. */
export type SeedableTaskStatus = TaskStatus

/**
 * Queue buckets a file can be READ from — wider than {@link SeedableTaskStatus}
 * because `corrupt/` holds raw unparseable files (seeded via
 * `seedCorruptTaskFile`, not `seedTask`), but callers still need to assert on
 * its contents (e.g. confirming a corrupt file was deleted after the admin UI
 * acts on it).
 */
export type TaskBucket = SeedableTaskStatus | 'corrupt'

export function getTasksDir(): string {
  return TASKS_DIR
}

export function getBranchesDir(): string {
  return BRANCHES_DIR
}

/**
 * Delete all task-queue state: every bucket, the worker heartbeat lock, and
 * the worker's self-reported status file.
 *
 * `resetWorkspace()` in test-workspace.ts only resets `content-branches/`;
 * `.tasks/` lives beside it and would otherwise leak across tests AND across
 * whole suite runs (the state-leak proof runs the suite twice without wiping
 * `.canopy-dev`). Called from `resetWorkspace()` so every spec inherits it.
 */
export async function resetTaskQueue(): Promise<void> {
  await Promise.all(
    TASK_DIRS.map((d) => fs.rm(path.join(TASKS_DIR, d), { recursive: true, force: true })),
  )
  await fs.rm(path.join(TASKS_DIR, 'worker-status.json'), { force: true })
  await fs.rm(path.join(TASKS_DIR, '.worker-lock'), { recursive: true, force: true })
}

/**
 * Write a Task JSON file into one of the queue buckets.
 *
 * Returns the full task as written so callers can assert on its id — retry
 * tests in particular need the ORIGINAL id to prove the requeued copy got a
 * different one (`requeueFailedTask` mints a fresh UUID because dequeue dedup
 * would otherwise eat a same-id copy).
 */
export async function seedTask(
  status: SeedableTaskStatus,
  overrides: Partial<Task> & Pick<Task, 'id'>,
): Promise<Task> {
  const task: Task = {
    action: 'e2e-seeded-action',
    payload: {},
    status,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  }
  const dir = path.join(TASKS_DIR, status)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf8')
  return task
}

/**
 * Write an unparseable file into `corrupt/`. The queue quarantines files it
 * cannot parse here; the admin Tasks tab lists them with a raw snippet so an
 * operator can decide whether to delete them.
 */
export async function seedCorruptTaskFile(fileName: string, raw: string): Promise<void> {
  const dir = path.join(TASKS_DIR, 'corrupt')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, fileName), raw, 'utf8')
}

/** Task ids currently present in a bucket (filenames minus `.json`). */
export async function listTaskIds(status: TaskBucket): Promise<string[]> {
  const dir = path.join(TASKS_DIR, status)
  const files = await fs.readdir(dir).catch(() => [] as string[])
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
}

export async function taskFileExists(status: TaskBucket, id: string): Promise<boolean> {
  return fs
    .access(path.join(TASKS_DIR, status, `${id}.json`))
    .then(() => true)
    .catch(() => false)
}

/**
 * Create the `.worker-lock` heartbeat directory with a chosen age.
 *
 * Liveness is classified purely from this directory's mtime against a
 * 150s threshold (60s worker refresh + 90s EFS attribute-cache slack), so
 * `ageMs: 0` reads as `alive` and anything past the threshold reads as
 * `stale`. Absence of the directory reads as `absent`.
 */
export async function seedWorkerLock(ageMs = 0): Promise<void> {
  const lockPath = path.join(TASKS_DIR, '.worker-lock')
  await fs.mkdir(lockPath, { recursive: true })
  const when = new Date(Date.now() - ageMs)
  await fs.utimes(lockPath, when, when)
}

export async function removeWorkerLock(): Promise<void> {
  await fs.rm(path.join(TASKS_DIR, '.worker-lock'), { recursive: true, force: true })
}

/**
 * Write `worker-status.json` — the worker's self-reported health snapshot.
 * Written as a full report (the real writer never does partial merges), with
 * sensible defaults so callers only specify the fields under test.
 */
export async function seedWorkerStatus(
  overrides: Partial<WorkerStatusReport> = {},
): Promise<WorkerStatusReport> {
  const now = new Date().toISOString()
  const report: WorkerStatusReport = {
    version: 1,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  }
  await fs.mkdir(TASKS_DIR, { recursive: true })
  await fs.writeFile(
    path.join(TASKS_DIR, 'worker-status.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  )
  return report
}

/** Write a deliberately unparseable worker-status.json (drives statusReadError). */
export async function seedUnparseableWorkerStatus(raw = '{ not json'): Promise<void> {
  await fs.mkdir(TASKS_DIR, { recursive: true })
  await fs.writeFile(path.join(TASKS_DIR, 'worker-status.json'), raw, 'utf8')
}

/**
 * Create a branch directory whose `.canopy-meta/branch.json` is unparseable.
 *
 * Two behaviours depend on this: the registry QUARANTINES the directory (the
 * branch silently drops out of the branch list instead of 500ing the whole
 * list), and the admin branch-health scan classifies it `corrupt-metadata`
 * and offers Repair.
 */
export async function seedCorruptBranchDir(
  dirName: string,
  raw = '{ this is not json',
): Promise<string> {
  const dir = path.join(BRANCHES_DIR, dirName)
  await fs.mkdir(path.join(dir, '.canopy-meta'), { recursive: true })
  await fs.writeFile(path.join(dir, '.canopy-meta', 'branch.json'), raw, 'utf8')
  await bumpBranchRegistry()
  return dir
}

/**
 * Create a branch directory with no `.canopy-meta` at all — an "orphan", the
 * signature of a clone that died partway through provisioning.
 *
 * `ageMs` backdates the directory mtime: purge refuses orphans younger than
 * 15 minutes (they may be a clone still in progress), so a purge test must
 * age the directory past that rail.
 */
export async function seedOrphanBranchDir(dirName: string, ageMs = 0): Promise<string> {
  const dir = path.join(BRANCHES_DIR, dirName)
  await fs.mkdir(dir, { recursive: true })
  // A marker file keeps the directory non-empty without creating .canopy-meta,
  // which would make the scan classify it healthy-or-corrupt instead of orphan.
  await fs.writeFile(path.join(dir, 'placeholder.txt'), 'orphaned clone\n', 'utf8')
  const when = new Date(Date.now() - ageMs)
  await fs.utimes(dir, when, when)
  await bumpBranchRegistry()
  return dir
}

/**
 * On-disk shape of `branch.json` (see `BranchMetadataFile` in
 * branch-metadata.ts): an OCC envelope (`schemaVersion`/`version`/`writeId`)
 * wrapping the actual `BranchMetadata` under `branch`. `readBranchMetadata`/
 * `patchBranchMetadata` used to read/write this object AS IF it were the flat
 * `BranchMetadata` itself -- every field read back (`status`, `createdBy`,
 * ...) was `undefined`, and every patched field (`rebaseFailure`,
 * `pullRequestNumber`, ...) landed as a sibling of `branch` instead of inside
 * it, invisible to the real `branch.status`/`b.rebaseFailure` reads the
 * component and API handlers actually do.
 */
interface BranchMetadataFileOnDisk {
  schemaVersion?: number
  version?: number
  writeId?: string
  branch: BranchMetadata
}

/** Read a branch directory's metadata. Throws if absent or unparseable. */
export async function readBranchMetadata(dirName: string): Promise<BranchMetadata> {
  const raw = await fs.readFile(
    path.join(BRANCHES_DIR, dirName, '.canopy-meta/branch.json'),
    'utf8',
  )
  const file = JSON.parse(raw) as BranchMetadataFileOnDisk
  return file.branch
}

/**
 * Shallow-merge a patch into a branch directory's `branch.json`, under the
 * `branch` key (see {@link BranchMetadataFileOnDisk}) -- the envelope's own
 * `schemaVersion`/`version`/`writeId` are preserved untouched so a later
 * legitimate `save()` (which does its own OCC read/increment) isn't confused
 * by this out-of-band write.
 *
 * Used to seed states the dev harness cannot produce for real — most
 * importantly `rebaseFailure`, which the worker only writes after a rebase
 * genuinely fails, and which it rate-limits to one write per hour per
 * identical message.
 */
export async function patchBranchMetadata(
  dirName: string,
  patch: Partial<BranchMetadata>,
): Promise<BranchMetadata> {
  const metaPath = path.join(BRANCHES_DIR, dirName, '.canopy-meta/branch.json')
  const current = JSON.parse(await fs.readFile(metaPath, 'utf8')) as BranchMetadataFileOnDisk
  const nextBranch = { ...current.branch, ...patch }
  const next: BranchMetadataFileOnDisk = { ...current, branch: nextBranch }
  await fs.writeFile(metaPath, JSON.stringify(next, null, 2), 'utf8')
  await bumpBranchRegistry()
  return nextBranch
}

/** Directory names directly under content-branches/ (includes dot-prefixed). */
export async function listBranchDirs(): Promise<string[]> {
  const entries = await fs.readdir(BRANCHES_DIR, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

/**
 * Find the trash directory a purge produced for `dirName`.
 *
 * Purge renames the directory to `.trash-{dirName}-{STAMP}` where STAMP is a
 * compact UTC `YYYYMMDDTHHMMSSZ`. Retention is computed by PARSING THAT NAME,
 * not from mtime — `rename()` preserves the original mtime, so an mtime-based
 * sweep would delete a long-stale orphan's trash on the first pass. Tests
 * assert the name shape for exactly that reason.
 */
export async function findTrashDirFor(dirName: string): Promise<string | null> {
  const dirs = await listBranchDirs()
  const prefix = `.trash-${dirName}-`
  return dirs.find((d) => d.startsWith(prefix)) ?? null
}

/** The trash-name stamp format the worker's sweeper parses. */
export const TRASH_NAME_RE = /^\.trash-(.+)-(\d{8}T\d{6}Z)$/

/** The archive name repair gives the corrupt file it replaces. */
export const CORRUPT_ARCHIVE_RE = /^branch\.json\.corrupt-\d{8}T\d{6}Z$/

/** Files present in a branch directory's .canopy-meta (for archive assertions). */
export async function listBranchMetaFiles(dirName: string): Promise<string[]> {
  return fs.readdir(path.join(BRANCHES_DIR, dirName, '.canopy-meta')).catch(() => [] as string[])
}

/**
 * Bump the branch-registry generation marker so the server rescans branch
 * directories on the next request instead of serving a cached list. Mirrors
 * what `resetWorkspace()` does after it deletes feature branches.
 */
async function bumpBranchRegistry(): Promise<void> {
  await fs.mkdir(path.join(BRANCHES_DIR, '.canopy-meta'), { recursive: true })
  await bumpResourceGeneration(BRANCHES_DIR, 'branch-registry')
}

export { bumpBranchRegistry }
