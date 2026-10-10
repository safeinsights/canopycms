import { repackBareRemoteIfNeeded, type BareRemoteRepackResult } from '../git-manager'
import { workerLog } from './log'
import { sharedRepoGitOptions } from './shared-repo-git'

/** The worker's per-cycle repack of `remote.git` (git-manager.ts owns the rule), logged. */
export async function maintainRemoteGit(gitDir: string): Promise<BareRemoteRepackResult> {
  const result = await repackBareRemoteIfNeeded(gitDir, sharedRepoGitOptions('bare'))
  if (result.repacked) {
    workerLog(
      `remote.git maintenance: loose ${result.before.loose}→${result.after.loose} ` +
        `packs ${result.before.packs}→${result.after.packs} in ${result.ms} ms`,
    )
  }
  return result
}
