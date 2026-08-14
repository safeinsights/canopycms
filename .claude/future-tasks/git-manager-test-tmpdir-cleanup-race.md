# `git-manager.test.ts` tmpdir cleanup races with lingering git processes

Observed on CI 2026-08-12 (PR #186, run 31648351324), on a branch that touches
nothing in `git-manager.ts` or its test:

```
FAIL  src/git-manager.test.ts > GitManager.ensureLocalSimulatedRemote >
      never updates a branch that already exists in the remote
Error: ENOTEMPTY: directory not empty, rmdir '/tmp/canopy-git-test-Ts9jVl/.git/info'
```

Everything else in that run passed (188 files, 3295 tests). A re-run of the
same commit went green, so this is intermittent, not a hard failure.

## Where it comes from

`describe('GitManager.ensureLocalSimulatedRemote')`
(`packages/canopycms/src/git-manager.test.ts:20-30`) does:

```ts
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-git-test-'))
})
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})
```

`force: true` suppresses ENOENT, but NOT ENOTEMPTY — `fs.rm` still throws if a
directory gains an entry between the readdir and the rmdir. So the failure is a
concurrent *writer*, not a missing file.

Leading hypothesis: a git subprocess is still running when `afterEach` fires.
These tests create a bare remote *inside* `tmpDir` and push to it, and
`git push`/`git commit` can spawn a detached `git gc --auto` / `git maintenance`
that writes into `.git/` after the foreground command has already exited and
simple-git's promise has resolved. `.git/info` is consistent with that (gc
writes `info/commit-graph`). CI's slower, more contended IO widens the window,
which is why it shows up there and not locally.

## Fix directions (unverified — pick after confirming the writer)

- Set `gc.auto=0` (and `maintenance.auto=0`) on the test repos, via
  `initTestRepo`, so no background git work is ever spawned. Cheapest, and
  addresses the cause rather than the symptom.
- Alternatively/additionally, make cleanup tolerant: retry the `fs.rm` a few
  times on ENOTEMPTY, or use `fs.rm(..., { maxRetries, retryDelay })` which
  Node supports natively for exactly this class of race.
- Do NOT simply swallow the cleanup error: that would leak tmpdirs on every run.

Worth checking whether other suites that shell out to git under a mkdtemp share
the same `afterEach` shape — the fix probably belongs in one shared helper.

## Related

- [markdownfield-mdxeditor-mount-flake](resolved/markdownfield-mdxeditor-mount-flake.md) — the other known intermittent in this
  suite. Unrelated cause; listed together because both make a green CI run
  non-deterministic and both cost a re-run to diagnose.
