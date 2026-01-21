import { simpleGit, type SimpleGit } from 'simple-git'

/**
 * Initialize a test git repository with CanopyCMS marker and user config.
 * This ensures the repo can be used with GitManager.ensureAuthor().
 *
 * @param baseDir - Directory to initialize git repo in
 * @param options - Optional configuration
 * @returns SimpleGit instance for the initialized repo
 *
 * @example
 * const git = await initTestRepo(tmpDir)
 * await git.add(['.'])
 * await git.commit('Initial commit')
 */
export async function initTestRepo(
  baseDir: string,
  options?: {
    /** Git user name (default: 'Test Bot') */
    userName?: string
    /** Git user email (default: 'test@canopycms.test') */
    userEmail?: string
  },
): Promise<SimpleGit> {
  const git = simpleGit({ baseDir })
  await git.init()
  await git.addConfig('canopycms.managed', 'true')
  await git.addConfig('user.name', options?.userName ?? 'Test Bot')
  await git.addConfig('user.email', options?.userEmail ?? 'test@canopycms.test')
  return git
}
