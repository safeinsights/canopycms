import { simpleGit, type SimpleGit } from 'simple-git'
import { gitChildEnv } from '../git-manager'
import { workerLog } from './log'

/** Above either count, `maintainRemoteGit` repacks. */
const REMOTE_GIT_MAX_LOOSE_OBJECTS = 50
const REMOTE_GIT_MAX_PACKS = 6

function bareGit(): SimpleGit {
  return simpleGit().env(gitChildEnv({}))
}

interface ObjectCounts {
  loose: number
  packs: number
}

async function countObjects(git: SimpleGit, gitDir: string): Promise<ObjectCounts> {
  const output = await git.raw(['--git-dir', gitDir, 'count-objects', '-v'])
  const fields = new Map(
    output.split('\n').map((line): [string, string] => {
      const [name, value = ''] = line.split(': ')
      return [name, value.trim()]
    }),
  )
  const field = (name: string): number => {
    const value = fields.get(name)
    if (!value || !/^\d+$/.test(value)) {
      throw new Error(`count-objects -v printed no '${name}' count: ${output.trim()}`)
    }
    return Number(value)
  }
  return { loose: field('count'), packs: field('packs') }
}

export type RemoteGitMaintenanceResult =
  | { repacked: false; before: ObjectCounts }
  | { repacked: true; before: ObjectCounts; after: ObjectCounts; ms: number }

/**
 * Repack `remote.git` once it holds more than {@link REMOTE_GIT_MAX_LOOSE_OBJECTS}
 * loose objects or {@link REMOTE_GIT_MAX_PACKS} packs, then pack its refs.
 *
 * Safe beside the Lambda's concurrent pushes and clones, which is why it is
 * `--cruft` with no expiry: unreachable objects move into a cruft pack rather
 * than being dropped, so a push that read an old object before the repack
 * still finds it, and a repack only deletes packs it listed when it began. A
 * clone that hardlinked a pack keeps that inode when the repack unlinks
 * remote.git's name for it, and packs are never modified in place.
 * `repack -d` also removes the loose objects it packed and their emptied
 * fan-out directories.
 */
export async function maintainRemoteGit(gitDir: string): Promise<RemoteGitMaintenanceResult> {
  const git = bareGit()
  const before = await countObjects(git, gitDir)
  if (before.loose <= REMOTE_GIT_MAX_LOOSE_OBJECTS && before.packs <= REMOTE_GIT_MAX_PACKS) {
    return { repacked: false, before }
  }
  const startedAt = Date.now()
  await git.raw(['--git-dir', gitDir, 'repack', '-a', '-d', '--cruft', '-q'])
  await git.raw(['--git-dir', gitDir, 'pack-refs', '--all'])
  const after = await countObjects(git, gitDir)
  const ms = Date.now() - startedAt
  workerLog(
    `remote.git maintenance: loose ${before.loose}→${after.loose} ` +
      `packs ${before.packs}→${after.packs} in ${ms} ms`,
  )
  return { repacked: true, before, after, ms }
}
