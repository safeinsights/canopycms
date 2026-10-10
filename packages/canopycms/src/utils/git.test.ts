import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import {
  detectHeadBranch,
  isNetworkRemoteUrl,
  isNonFastForwardRejection,
  resolveBaseBranch,
  stageAllExceptCanopyState,
  workflowPushRefusalFile,
} from './git'
import { BaseBranchUnresolvedError } from './base-branch'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-utilsgit-'))

/** Create a repo with one commit on `main` and check out the given branch. */
async function initRepo(branch = 'main'): Promise<string> {
  const root = await tmpDir()
  const git = simpleGit({ baseDir: root })
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.name', 'Test')
  await git.addConfig('user.email', 'test@test.com')
  await fs.writeFile(path.join(root, 'README.md'), '# test\n')
  await git.add('-A')
  await git.commit('initial commit')
  if (branch !== 'main') {
    await git.checkoutLocalBranch(branch)
  }
  return root
}

describe('isNetworkRemoteUrl', () => {
  it.each([
    ['/abs/path/remote.git'],
    ['./relative/path'],
    ['relative/path/repo.git'],
    ['file:///srv/git/repo.git'],
    ['C:\\repos\\repo.git'],
    ['C:/repos/repo.git'],
  ])('treats %s as local', (url) => {
    expect(isNetworkRemoteUrl(url)).toBe(false)
  })

  it.each([
    ['https://github.com/o/r.git'],
    ['ssh://git@host/r.git'],
    ['git://host/r.git'],
    ['git@github.com:o/r.git'],
    ['github.com:owner/repo.git'],
    ['host:path'],
    ['ext::sh -c whoami'],
    ['fd::7'],
    ['--upload-pack=/tmp/evil'],
    ['-o=foo'],
  ])('treats %s as network', (url) => {
    expect(isNetworkRemoteUrl(url)).toBe(true)
  })
})

describe('detectHeadBranch', () => {
  it('returns the checked-out branch', async () => {
    const root = await initRepo('feature-z')
    expect(await detectHeadBranch(root)).toBe('feature-z')
  })

  it('returns the fallback on detached HEAD', async () => {
    const root = await initRepo()
    const git = simpleGit({ baseDir: root })
    await git.checkout(['--detach'])
    expect(await detectHeadBranch(root)).toBe('main')
    expect(await detectHeadBranch(root, 'develop')).toBe('develop')
  })

  it('returns the fallback outside a git repo', async () => {
    const root = await tmpDir()
    expect(await detectHeadBranch(root, 'develop')).toBe('develop')
  })
})

describe('resolveBaseBranch', () => {
  it('explicit defaultBaseBranch always wins, in both modes', async () => {
    const root = await initRepo('feature-z')
    expect(
      await resolveBaseBranch({ defaultBaseBranch: 'develop', mode: 'dev', detectFrom: root }),
    ).toBe('develop')
    expect(
      await resolveBaseBranch({ defaultBaseBranch: 'develop', mode: 'prod', detectFrom: root }),
    ).toBe('develop')
  })

  it('dev mode detects the checked-out branch when unset', async () => {
    const root = await initRepo('feature-z')
    expect(await resolveBaseBranch({ mode: 'dev', detectFrom: root })).toBe('feature-z')
  })

  it('dev mode falls back to main on detached HEAD', async () => {
    const root = await initRepo()
    const git = simpleGit({ baseDir: root })
    await git.checkout(['--detach'])
    expect(await resolveBaseBranch({ mode: 'dev', detectFrom: root })).toBe('main')
  })

  it('prod mode reads the base branch from the remote HEAD, including a non-main name', async () => {
    const source = await initRepo('production')
    const remoteGitDir = path.join(await tmpDir(), 'remote.git')
    await simpleGit().clone(source, remoteGitDir, ['--bare'])
    expect(await resolveBaseBranch({ mode: 'prod', remoteGitDir })).toBe('production')
    expect(
      await resolveBaseBranch({ defaultBaseBranch: 'develop', mode: 'prod', remoteGitDir }),
    ).toBe('develop')
  })

  it('prod mode never falls back to the checkout HEAD or to main', async () => {
    const root = await initRepo('feature-z')
    await expect(resolveBaseBranch({ mode: 'prod', detectFrom: root })).rejects.toThrow(
      BaseBranchUnresolvedError,
    )
    await expect(resolveBaseBranch({ mode: 'prod', detectFrom: root })).rejects.toThrow(
      /defaultBaseBranch/,
    )
  })

  it('prod mode fails loudly when the remote HEAD names no branch with a commit', async () => {
    const remoteGitDir = path.join(await tmpDir(), 'remote.git')
    await simpleGit().raw(['init', '--bare', '--initial-branch=production', remoteGitDir])
    await expect(resolveBaseBranch({ mode: 'prod', remoteGitDir })).rejects.toThrow(
      /defaultBaseBranch is not set, and the base branch could not be read from/,
    )
  })

  it('prod mode fails loudly on a detached remote HEAD or a missing remote', async () => {
    const source = await initRepo()
    const remoteGitDir = path.join(await tmpDir(), 'remote.git')
    await simpleGit().clone(source, remoteGitDir, ['--bare'])
    const sha = (await simpleGit().raw(['--git-dir', remoteGitDir, 'rev-parse', 'HEAD'])).trim()
    await simpleGit().raw(['--git-dir', remoteGitDir, 'update-ref', '--no-deref', 'HEAD', sha])
    await expect(resolveBaseBranch({ mode: 'prod', remoteGitDir })).rejects.toThrow(
      BaseBranchUnresolvedError,
    )
    await expect(
      resolveBaseBranch({ mode: 'prod', remoteGitDir: path.join(remoteGitDir, 'absent') }),
    ).rejects.toThrow(BaseBranchUnresolvedError)
  })
})

describe('isNonFastForwardRejection', () => {
  // All fixtures below are VERBATIM output captured from real git (LC_ALL=C
  // LANG=C), not invented strings. Captured by: creating a bare "github.git"
  // remote plus two independent clones, having clone A push a commit, then
  // clone B (which forked from the same point but never saw A's commit)
  // attempt to push its own diverging commit to the same branch name -- the
  // exact "two CanopyCMS deployments, one branch name" collision this
  // predicate exists to detect.

  // `git push` via simple-git's `.push()` wrapper (what
  // CmsWorker.pushBranchToGitHub / pushSettingsBranches use), which appends
  // `--porcelain` -- clone B had never fetched clone A's push, so git reports
  // "fetch first" (no local knowledge of the remote ref at all).
  const PORCELAIN_FETCH_FIRST =
    'To /tmp/canopy-test/github.git\n' +
    '!\trefs/heads/content-branch:refs/heads/content-branch\t[rejected] (fetch first)\n' +
    'Done\n' +
    'Pushing to /tmp/canopy-test/github.git\n' +
    "error: failed to push some refs to '/tmp/canopy-test/github.git'\n" +
    'hint: Updates were rejected because the remote contains work that you do not\n' +
    'hint: have locally. This is usually caused by another repository pushing to\n' +
    'hint: the same ref. If you want to integrate the remote changes, use\n' +
    "hint: 'git pull' before pushing again.\n" +
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.\n"

  // Same wrapper, but clone B fetched clone A's push before retrying -- git
  // now has a (stale) remote-tracking ref, so it reports "non-fast-forward"
  // instead of "fetch first".
  const PORCELAIN_NON_FAST_FORWARD =
    'To /tmp/canopy-test/github.git\n' +
    '!\trefs/heads/content-branch:refs/heads/content-branch\t[rejected] (non-fast-forward)\n' +
    'Done\n' +
    'Pushing to /tmp/canopy-test/github.git\n' +
    "error: failed to push some refs to '/tmp/canopy-test/github.git'\n" +
    'hint: Updates were rejected because the tip of your current branch is behind\n' +
    'hint: its remote counterpart. If you want to integrate the remote changes,\n' +
    "hint: use 'git pull' before pushing again.\n" +
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.\n"

  // Same scenario, but via `.raw(['push', ...])` (what GitManager.push() —
  // CanopyCMS's hop-1 Lambda->remote.git push — uses instead of the
  // `.push()` wrapper): the plain human CLI format, no --porcelain.
  const RAW_CLI_NON_FAST_FORWARD =
    'To /tmp/canopy-test/github.git\n' +
    ' ! [rejected]        content-branch -> content-branch (non-fast-forward)\n' +
    "error: failed to push some refs to '/tmp/canopy-test/github.git'\n" +
    'hint: Updates were rejected because the tip of your current branch is behind\n' +
    'hint: its remote counterpart. If you want to integrate the remote changes,\n' +
    "hint: use 'git pull' before pushing again.\n" +
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.\n"

  it.each([
    ['porcelain, fetch first', PORCELAIN_FETCH_FIRST],
    ['porcelain, non-fast-forward', PORCELAIN_NON_FAST_FORWARD],
    ['raw CLI, non-fast-forward', RAW_CLI_NON_FAST_FORWARD],
  ])('classifies a real captured %s rejection as non-fast-forward', (_label, message) => {
    expect(isNonFastForwardRejection(message)).toBe(true)
  })

  // Negative fixtures, also captured from real git (not invented): a genuine
  // DNS-resolution network failure, and a genuine permission-denied failure
  // (git's canonical wording for "can't read from the remote" -- the same
  // message it gives for a real auth rejection). Neither must classify as a
  // non-fast-forward rejection: both are transient/permission failures that
  // must keep their existing retry behavior.
  const NETWORK_FAILURE =
    'Pushing to https://canopy-test-nonexistent-host.invalid/repo.git\n' +
    "fatal: unable to access 'https://canopy-test-nonexistent-host.invalid/repo.git/': " +
    'Could not resolve host: canopy-test-nonexistent-host.invalid\n'

  const AUTH_FAILURE =
    'Pushing to /tmp/canopy-test/locked.git\n' +
    "fatal: '/tmp/canopy-test/locked.git' does not appear to be a git repository\n" +
    'fatal: Could not read from remote repository.\n\n' +
    'Please make sure you have the correct access rights\n' +
    'and the repository exists.\n'

  it.each([
    ['network failure (DNS resolution)', NETWORK_FAILURE],
    ['auth/permission failure', AUTH_FAILURE],
  ])('does not classify a real captured %s as non-fast-forward', (_label, message) => {
    expect(isNonFastForwardRejection(message)).toBe(false)
  })
})

describe('workflowPushRefusalFile', () => {
  // Refusals captured from real GitHub (LC_ALL=C), verbatim apart from the repository
  // URL. Each is a direct edit to a workflow file pushed by a credential without the
  // workflows permission, in the
  // `--verbose --porcelain` shape simple-git's `.push()` produces. The App token was
  // GitHub Actions' GITHUB_TOKEN; the OAuth token was a `gh` login holding `repo` but
  // not `workflow`.
  const APP_TOKEN_REFUSAL =
    'Pushing to https://github.com/test-owner/test-repo\n' +
    'POST git-receive-pack (654 bytes)\n' +
    "error: failed to push some refs to 'https://github.com/test-owner/test-repo'\n" +
    'To https://github.com/test-owner/test-repo\n' +
    '!\tHEAD:refs/heads/app-porcelain\t[remote rejected] (refusing to allow a GitHub App to ' +
    'create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\n' +
    'Done'

  const OAUTH_TOKEN_REFUSAL =
    'To https://github.com/test-owner/test-repo.git\n' +
    '!\trefs/heads/s0p:refs/heads/oauth-porcelain\t[remote rejected] (refusing to allow an ' +
    'OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\n' +
    'Done\n' +
    'Pushing to https://github.com/test-owner/test-repo.git\n' +
    'POST git-receive-pack (671 bytes)\n' +
    "error: failed to push some refs to 'https://github.com/test-owner/test-repo.git'\n"

  it.each([
    ['GitHub App token', APP_TOKEN_REFUSAL],
    ['OAuth token without the workflow scope', OAUTH_TOKEN_REFUSAL],
  ])('names the workflow file in a real captured refusal of a %s', (_label, message) => {
    expect(workflowPushRefusalFile(message)).toBe('.github/workflows/ci.yml')
  })

  it.each([
    [
      'a non-fast-forward rejection',
      '!\trefs/heads/b:refs/heads/b\t[rejected] (non-fast-forward)\n' +
        'hint: Updates were rejected because the tip of your current branch is behind\n',
    ],
    ['a stale lease', ' ! [rejected]        b -> b (stale info)\n'],
    ['a declined pre-receive hook', ' ! [remote rejected] b -> b (pre-receive hook declined)\n'],
    ['an auth failure', 'fatal: Could not read from remote repository.\n'],
    [
      'a refusal whose file name is not closed on its own line',
      '[remote rejected] (refusing to allow a GitHub App to create or update workflow ' +
        '`.github/workflows/ci.yml without workflows permission)\nTo https://github.com/o/r\n `',
    ],
  ])('returns null for %s', (_label, message) => {
    expect(workflowPushRefusalFile(message)).toBeNull()
  })
})

describe('stageAllExceptCanopyState', () => {
  /** A repo whose HEAD tracks content plus `.canopy-meta/` state, with the clone's exclude. */
  async function repoTrackingCanopyMeta(): Promise<string> {
    const root = await tmpDir()
    const git = simpleGit({ baseDir: root })
    await git.init()
    await git.addConfig('user.name', 'Test Bot')
    await git.addConfig('user.email', 'test@canopycms.test')
    await fs.mkdir(path.join(root, 'content'))
    await fs.mkdir(path.join(root, '.canopy-meta'))
    for (const [file, body] of Object.entries({
      'content/edited.md': 'one',
      'content/gone.md': 'two',
      'content/move-from.md': 'a body long enough for git to detect the rename\n'.repeat(4),
      '.canopy-meta/branch.json': '{"committed":true}',
      '.canopy-meta/comments.json': '[]',
    })) {
      await fs.writeFile(path.join(root, file), body)
    }
    await git.add(['.'])
    await git.commit('initial')
    await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '.canopy-meta/\n')
    return root
  }

  it('stages content edits, deletions and renames, and none of the canopycms state', async () => {
    const root = await repoTrackingCanopyMeta()
    const git = simpleGit({ baseDir: root })
    await fs.writeFile(path.join(root, 'content/edited.md'), 'one, edited')
    await fs.rm(path.join(root, 'content/gone.md'))
    await fs.rename(path.join(root, 'content/move-from.md'), path.join(root, 'content/moved.md'))
    await fs.writeFile(path.join(root, 'content/new.md'), 'new')
    await fs.writeFile(path.join(root, '.canopy-meta/branch.json'), '{"live":true}')
    await fs.rm(path.join(root, '.canopy-meta/comments.json'))
    await fs.writeFile(path.join(root, '.canopy-meta/schema.generation'), 'token')

    await stageAllExceptCanopyState(git)

    const staged = (await git.raw(['diff', '--cached', '--name-status', '-M']))
      .trim()
      .split('\n')
      .map((line) => line.replace(/^R\d+/, 'R'))
      .sort()
    expect(staged).toEqual([
      'A\tcontent/new.md',
      'D\tcontent/gone.md',
      'M\tcontent/edited.md',
      'R\tcontent/move-from.md\tcontent/moved.md',
    ])
    // The tracked state's changes stay in the working tree, unstaged and intact.
    const unstaged = (await git.raw(['diff', '--name-status'])).trim().split('\n').sort()
    expect(unstaged).toEqual(['D\t.canopy-meta/comments.json', 'M\t.canopy-meta/branch.json'])
    await expect(fs.readFile(path.join(root, '.canopy-meta/branch.json'), 'utf8')).resolves.toBe(
      '{"live":true}',
    )
  })

  it('stages nothing when canopycms state is the only change', async () => {
    const root = await repoTrackingCanopyMeta()
    const git = simpleGit({ baseDir: root })
    await fs.writeFile(path.join(root, '.canopy-meta/branch.json'), '{"live":true}')

    await stageAllExceptCanopyState(git)

    expect(await git.raw(['diff', '--cached', '--name-only'])).toBe('')
  })

  it('works in a repo with no .canopy-meta at all', async () => {
    const root = await initRepo()
    const git = simpleGit({ baseDir: root })
    await fs.writeFile(path.join(root, 'x.md'), 'x')

    await stageAllExceptCanopyState(git)

    expect((await git.raw(['diff', '--cached', '--name-only'])).trim()).toBe('x.md')
  })

  it('in a sparse clone, stages what is on disk outside the cone and never what is not', async () => {
    const root = await repoTrackingCanopyMeta()
    const git = simpleGit({ baseDir: root })
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src/app.ts'), 'tracked, outside the cone')
    await git.add(['src/app.ts'])
    await git.commit('add src')
    await git.raw(['sparse-checkout', 'set', '--cone', 'content', '.canopy-meta'])
    await expect(fs.stat(path.join(root, 'src/app.ts'))).rejects.toThrow()
    await fs.writeFile(path.join(root, 'content/edited.md'), 'one, edited')
    await fs.writeFile(path.join(root, 'root-new.md'), 'root')
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src/stray.ts'), 'untracked, outside the cone')

    await stageAllExceptCanopyState(git)

    const staged = (await git.raw(['diff', '--cached', '--name-status'])).trim().split('\n').sort()
    // src/app.ts is absent only because it is out of the cone, so it is not a deletion.
    expect(staged).toEqual(['A\troot-new.md', 'A\tsrc/stray.ts', 'M\tcontent/edited.md'])
  })
})
