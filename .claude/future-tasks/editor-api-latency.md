# Editor API latency: ~2 s per call on Lambda + EFS, reads included

**Status:** Open. **Priority: P1 [BOTH].** Filed 2026-10-04 from item #11 of the editor-debug
batch (int-202610-a). The largest suspect has a fix in flight (see "Suspect 1"); this file holds
the evidence, the remaining ranked suspects, and how to get the deployed breakdown.

## Problem

On the first deployed editor (canopycms `0.0.67-int.91`, Lambda + EFS + EC2 worker), warm
requests took about 2 s each, reads included: save 2.75 s, `schema` 2.07 s,
`entries?limit=200` 2.27 s; earlier, on the base branch, `entries` 4.6 s, `comments` 3.5 s and
`content/site` 2.45 s. Nothing on the read path was timed, so there was no way to say where it went.

## Instrumentation (shipped with this file)

`CANOPYCMS_DEBUG=true` makes the API handler log **one line per request**
(`utils/request-timing.ts`):

```
<ISO time> [CanopyCMS:timing] [DEBUG] GET :branch/entries 200 646ms | context=0 refreshBranch=0 auth=0 branchContext=0 user=312 user>settingsRoot=312 user>groups=0 route=334 route>branchContext=2 route>branchContext>schema=1 route>settingsRoot=323 route>permissions=0 untimed=0
```

- The route is the **pattern** (`:branch/entries`), never the raw path, so lines aggregate and carry no branch names.
- `a>b` is phase `b` nested inside `a`; nested time is already inside its parent. `(xN)` means it ran N times.
- `untimed` = total minus the top-level phases (body parsing, validation, response building).
- `schema>resolve` appears only on a schema-cache **miss**.
- Spans are per request (AsyncLocalStorage), so concurrent requests never mix; disabled, no scope is opened.

### Getting the deployed breakdown (for JP; nothing here changes code)

1. On the editor Lambda of the tier under test, set the environment variable
   `CANOPYCMS_DEBUG=true` (this is the existing debug switch; it also turns on the other DEBUG
   lines, which are harmless but chatty).
2. Changing the environment makes Lambda start fresh execution environments. Load the editor
   once (that is a **cold** sample), wait ~1 minute, and reload twice (**warm** samples). In the
   editor: open an editing branch, open one entry, edit it and save, and open the comments panel.
   That exercises `whoami`, `branches`, `:branch/schema`, `:branch/entries`,
   `:branch/content/...path` (GET and PUT), `:branch/comments`, and `:branch/status`.
3. In CloudWatch Logs Insights on the Lambda's log group:
   ```
   fields @timestamp, @message
   | filter @message like /\[CanopyCMS:timing\]/
   | sort @timestamp asc
   ```
   Grab every line for the session, plus the Lambda `REPORT` lines (`Init Duration` marks cold
   starts). `filter @message like /ensureGitWorkspace completed/` adds the provisioning spans.
4. Turn `CANOPYCMS_DEBUG` back off afterwards.

Compare the warm lines against the local tables below: the same phase names, just EFS latencies.

## Measured: local disk, before and after the settings-ensure memo

In-process harness (appendix): the real prod-mode handler, real `createCanopyServices`, the
default `getBranchContext`, real git, against a temp workspace on local APFS. The content is the
example app's plus 200 generated posts (224 entries). fs calls and git spawns are counted by
wrapping `fs`, `fs/promises` and `child_process.spawn` before anything loads. Each row is the median of
6–12 samples: 3 runs × 2 users (bootstrap admin, plain editor), × 2 repeats for the
editing-branch endpoints. Wall times vary with machine load; the
counts are deterministic.

| Endpoint (warm)          | Before: wall | of which `settingsRoot` | git spawns | fs calls | After: wall | git | fs |
| ------------------------ | -----------: | ----------------------: | ---------: | -------: | ----------: | --: | -: |
| `whoami`                 |       366 ms |                  365 ms |         12 |       19 |        1 ms |   0 |  3 |
| `:branch/schema` (hit)   |       364 ms |                  361 ms |         12 |       22 |        5 ms |   0 |  6 |
| `:branch/entries`        |       713 ms |                  698 ms |         24 |      102 |       13 ms |   0 | 70 |
| `:branch/content` GET    |       690 ms |                  673 ms |         24 |       68 |       15 ms |   0 | 36 |
| `:branch/content` PUT    |       710 ms |                  698 ms |         24 |       81 |       27 ms |   0 | 49 |
| `:branch/comments`       |       351 ms |                  350 ms |         12 |       21 |        2 ms |   0 |  5 |
| `branches`               |       364 ms |                  363 ms |         12 |       21 |        2 ms |   0 |  5 |
| `:branch/status`         |       353 ms |                  350 ms |         12 |       20 |        1 ms |   0 |  4 |
| `branches` POST (create) |      1279 ms |                  398 ms |         25 |       74 |      898 ms |  13 | 58 |
| first request (cold)     |      1196 ms |                  613 ms |         21 |       58 |     1348 ms |  21 | 58 |

Both columns come from back-to-back runs on a quiet machine. An earlier pair, taken under load,
had the same shape, with before-times 1.3–1.7× higher.

"Before" is int-202610-a plus the instrumentation; "after" adds the memo. The cold row clones
both the base-branch and settings workspaces, and branch create clones its workspace; both are
one-offs and are not changed by the memo.

## Ranked suspects

### 1. Settings workspace re-ensured on every request (measured; fix in flight)

`resolveCanopyUser` → `services.getSettingsBranchRoot()` → `SettingsWorkspaceManager.ensureGitWorkspace`
ran the whole provisioning path on **every** call: its in-memory lock is cleared once init
finishes, so nothing remembered success. Per call (measured, argv captured):
`rev-parse --git-dir` ×3, `status` ×2, `config --local` ×3, `config --list`, `remote -v`,
`branch -v -a`, `checkout <settings branch>` (12 git subprocesses), plus a cross-host
proper-lockfile acquire/release (mkdir, stat, rmdir, refresh timer) and ~10 more fs calls. Routes
that build a content-access checker (`entries`, `content` GET/PUT) call it a second time, so 24
spawns. Locally that is 97.5–99.7% of every warm request.

On Lambda + EFS (reasoned, not measured): each git subprocess is a process spawn plus git
reading `.git/config`, `HEAD`, refs and the index over NFS, so tens of NFS round trips. At 50–150
ms each, 12 spawns come to 0.6–1.8 s per call, which is consistent with the deployed 2.07 s for
`schema` (one call). It is not linear in the call count, though: `entries`, with two calls, was
2.27 s, not about 4 s. The deployed breakdown will settle that.

**Fix:** `fix/settings-workspace-ensure-once` remembers each (settings root, branch name) a
process has fully ensured, and a hit costs one read of `.git/HEAD` (checked against the settings
branch). Only a process's first request still takes the cross-host init lock (measured: 4 lock
ops on the first request, 0 after). The groups and permissions
files are still read every request; a different branch name still runs the rename guard; a
workspace removed, re-cloned onto another branch, or caught mid-clone re-provisions. Documented in docs/concurrency.md ("Settings workspace init").

### 2. Cross-container queueing on the settings init lock (reasoned; same fix)

Each ensure took the **cross-host** provisioning lock, whose waiters poll every 300–800 ms
(jittered; `utils/provisioning-lock.ts`). The editor fires several requests in parallel on load,
and on Lambda each in-flight request runs in its own container, so those requests queued behind
each other's ensure at 300–800 ms per poll. That would explain why the base-branch load was worse
(`entries` 4.6 s, `comments` 3.5 s) than the single-request numbers. In one process the
in-memory lock coalesced them (measured: 4 concurrent `entries` finished together in about one request's time), so the
harness cannot show the cross-container case. The memo removes the lock from the request path
entirely.

### 3. Same directories re-read many times within one request (measured counts; EFS cost reasoned)

After the memo, the remaining per-request I/O is mostly `readdir`. Path capture for one warm
request each:

- `entries`: the branch root ×9, `content/` ×9, `docs.*` ×5, `api.*` ×3: 32 `readdir`s, plus 23 `readFile` and 15 `stat`.
- `content` GET: the branch root ×4, `content/` ×5, `posts.*` ×3, and every other collection directory once (the content-ID index walking the tree): 21 `readdir`s.
- `content` PUT: `posts.*` ×6, `content/` ×6, the branch root ×5, plus the full tree walk: 24 `readdir`s.

On EFS a `readdir` is a READDIR(PLUS) round trip that the attribute cache does not reliably
serve, and it grows with directory size (`posts/` here holds 203 files). At 2–5 ms per op,
`entries`' 70 fs calls are 140–350 ms. **Recommendation (not a PR):** a call-scoped directory-listing
memo threaded through one request's ContentStore/listing (the docs/concurrency.md "call-scoped
memo" recipe: per request, never module scope, memoize the promise). Find which callers repeat
first: the branch root and `content/` re-reads look like logical→physical path resolution
walking ID-suffixed directory names once per segment.

### 4. ContentId index rebuilt by a full tree walk on every read and write (measured; fix needs design)

`content` GET and PUT each `readdir` every collection directory once. The index lives as long as
one request's ContentStore, and the `content-index.generation` marker is read, but there is no
durable snapshot to reuse. Its cost grows with the number of collections and entries. A durable
snapshot keyed on the existing marker (the `branch-registry.ts` / `branch-schema-cache.ts`
pattern, including the window-E mitigations) is the shape of a fix. It is **not** obviously safe
(duplicate-ID quarantine [F1] and the rename invariants depend on it), so it goes through design
review first.

### 5. Save path extras (measured)

On top of #3/#4, a save takes the content-write lock (`mkdir`/`stat`/`rmdir` on
`.canopy-meta/content-write.lock`, cross-host by design, SYNC-C1), writes temp+rename for the
entry, and bumps the `content-index` marker (temp+rename). These are about 12 ops and each is
load-bearing; NFS close-to-open `COMMIT`s on the two renames are likely the most expensive part
on EFS (reasoned). No change recommended until the deployed breakdown shows `route` on PUT
dominating.

### 6. Duplicate settings reads per request (measured, minor)

After the memo, each request still reads `settings/.git/HEAD` and the settings files twice:
once for the user's groups, once for the access checker. Deduping those per request saves 2–3
NFS ops; do it only if the deployed lines show `settingsRoot`/`permissions` above a few ms.

### Not measured locally

- **`auth`.** The harness's auth plugin is in-memory. Deployed, `auth=` holds token
  verification plus `FileBasedAuthCache` (`auth/file-based-auth-cache.ts`): a symlink resolve
  and 3 `stat`s per lookup, and a full re-read of the three JSON files whenever the worker's
  refresh changes their mtime. Watch that number.
- **Cold starts.** The Lambda `Init Duration` plus the first request's `context=` (building
  services) and its one full ensure. These are one per container, but containers recycle.
- **The extra 308 round trip** from the client's URL building (item #9, separate chip).

## Appendix: the harness

Not committed to the package: it imports the example app's schema registry across the package
boundary and wraps Node built-ins globally. To re-run, drop the three files below into
`packages/canopycms/` (the two `src/` files under `src/`) and run
`pnpm exec vitest run --config vitest.harness.config.ts`, with `HARNESS_OUT=<file.json>`
for the per-request samples (wall time, timing line, git argv, fs counts and paths). Delete them
afterwards.

`packages/canopycms/vitest.harness.config.ts`:

```ts
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^canopycms\/server$/, replacement: path.resolve(__dirname, 'src/server.ts') },
      { find: /^canopycms$/, replacement: path.resolve(__dirname, 'src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/latency.harness.ts'],
    setupFiles: ['src/latency.harness-setup.ts'],
    env: { CANOPY_BOOTSTRAP_ADMIN_IDS: 'test-admin' },
    testTimeout: 600000,
  },
})
```

`packages/canopycms/src/latency.harness-setup.ts`:

```ts
// Installs fs/child_process counters before the harness imports anything, so modules
// that capture fs functions at load (graceful-fs under proper-lockfile) are counted too.
import { createRequire } from 'node:module'
import path from 'node:path'

const nodeRequire = createRequire(__filename)
const probe = {
  counting: false,
  fs: {} as Record<string, number>,
  git: [] as string[],
  paths: [] as string[],
}
;(globalThis as unknown as { __latencyProbe: typeof probe }).__latencyProbe = probe

function wrapAll(target: Record<string, unknown>, prefix: string) {
  for (const key of Object.keys(target)) {
    const orig = target[key]
    if (typeof orig !== 'function' || /^[A-Z]/.test(key)) continue
    const fn = orig as (...a: unknown[]) => unknown
    try {
      target[key] = function (this: unknown, ...args: unknown[]) {
        if (probe.counting) {
          probe.fs[`${prefix}${key}`] = (probe.fs[`${prefix}${key}`] ?? 0) + 1
          if (typeof args[0] === 'string') probe.paths.push(`${prefix}${key} ${args[0]}`)
        }
        return fn.apply(this, args)
      }
    } catch {
      // non-writable
    }
  }
}
wrapAll(nodeRequire('fs/promises') as Record<string, unknown>, 'p.')
wrapAll(nodeRequire('fs') as Record<string, unknown>, 'cb.')
const cp = nodeRequire('child_process') as { spawn: (...a: unknown[]) => unknown }
const origSpawn = cp.spawn
cp.spawn = function (this: unknown, cmd: unknown, args: unknown, opts: unknown) {
  if (probe.counting) {
    const argv = Array.isArray(args) ? args.join(' ') : ''
    probe.git.push(`${path.basename(String(cmd))} ${argv}`.slice(0, 120))
  }
  return origSpawn.call(this, cmd, args, opts)
}
;(nodeRequire('module') as { syncBuiltinESMExports: () => void }).syncBuiltinESMExports()
```

`packages/canopycms/src/latency.harness.ts`:

```ts
/**
 * Request-latency harness: drives the real prod-mode handler (real services, default
 * getBranchContext, real git) against a temp workspace on local disk, and records per
 * request: wall time, the CANOPYCMS_DEBUG timing summary, git subprocess spawns (and
 * their argv), and fs calls by name. Run with:
 *   pnpm exec vitest run --config vitest.harness.config.ts
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'vitest'

const fsp = createRequire(__filename)('fs/promises') as typeof import('node:fs/promises')
import { simpleGit } from 'simple-git'

import { createCanopyRequestHandler } from './http/handler'
import { createCanopyServices } from './services'
import { defineCanopyTestConfig } from './config-test'
import type { AuthPlugin } from './auth/plugin'
import type { CanopyRequest } from './http/types'
import { entrySchemaRegistry } from '../../../apps/example1/app/schemas'

const EXAMPLE_CONTENT = path.resolve(__dirname, '../../../apps/example1/content')
const EXTRA_POSTS = Number(process.env.HARNESS_EXTRA_POSTS ?? 200)
const OUT = process.env.HARNESS_OUT ?? path.join(os.tmpdir(), 'latency-harness.json')

// ---- instrumentation (installed by latency.harness-setup.ts before any import) ----
const probe = (globalThis as unknown as { __latencyProbe: LatencyProbe }).__latencyProbe
interface LatencyProbe {
  counting: boolean
  fs: Record<string, number>
  git: string[]
  paths: string[]
}

// ---- fixture ----------------------------------------------------------------
async function seedRepo(root: string): Promise<string> {
  const seed = path.join(root, 'seed')
  await fsp.cp(EXAMPLE_CONTENT, path.join(seed, 'content'), { recursive: true })
  const postsDir = path.join(seed, 'content', 'posts.916jXZabYCxu')
  const template = await fsp.readFile(
    path.join(postsDir, 'post.hello-world.vh2WdhwAFiSL.md'),
    'utf-8',
  )
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  for (let i = 0; i < EXTRA_POSTS; i++) {
    let id = ''
    for (let j = 0; j < 12; j++) id += alphabet[(i * 7 + j * 13 + j * i) % alphabet.length]
    id = `${id.slice(0, 8)}${String(i).padStart(4, '0')}`.slice(0, 12)
    await fsp.writeFile(path.join(postsDir, `post.gen-${i}.${id}.md`), template)
  }
  const git = simpleGit({ baseDir: seed })
  await git.init()
  await git.raw(['branch', '-M', 'main'])
  await git.addConfig('user.name', 'Seed')
  await git.addConfig('user.email', 'seed@example.test')
  await git.add(['.'])
  await git.commit('seed')
  const remote = path.join(root, 'remote.git')
  await simpleGit().raw(['clone', '--bare', seed, remote])
  return remote
}

function makeReq(method: string, url: string, body?: unknown): CanopyRequest {
  return {
    method,
    url,
    header: () => null,
    json: async () => body,
  }
}

const authPlugin = (userId: string): AuthPlugin => ({
  verifiesCredentials: true,
  authenticate: async () => ({
    success: true,
    user: { userId, email: `${userId}@x.test`, name: userId, externalGroups: [] },
  }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

interface Sample {
  label: string
  status: number
  wallMs: number
  summary: string
  git: string[]
  fs: Record<string, number>
  paths: string[]
}

describe('latency harness', () => {
  it('measures', { timeout: 600_000 }, async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'latency-'))
    const ws = path.join(root, 'workspace')
    await fsp.mkdir(ws)
    process.env.CANOPYCMS_WORKSPACE_ROOT = ws
    const remote = await seedRepo(root)
    await fsp.rename(remote, path.join(ws, 'remote.git'))

    const config = defineCanopyTestConfig({
      mode: 'prod',
      defaultBaseBranch: 'main',
      defaultBranchAccess: 'allow',
      defaultPathAccess: { read: 'allow', edit: 'allow' },
      deploymentName: 'harness',
      schema: { collections: [] },
    })
    const services = await createCanopyServices(config, { entrySchemaRegistry })

    const summaries: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ')
      if (line.includes('[CanopyCMS:timing]')) summaries.push(line)
    }
    const origWarn = console.warn
    console.warn = () => {}
    process.env.CANOPYCMS_DEBUG = 'true'

    const samples: Sample[] = []
    const run = async (
      label: string,
      handler: ReturnType<typeof createCanopyRequestHandler>,
      method: string,
      segs: string[],
      body?: unknown,
    ) => {
      probe.fs = {}
      probe.git = []
      probe.paths = []
      probe.counting = true
      summaries.length = 0
      const t0 = performance.now()
      const res = await handler(makeReq(method, `http://x/api/canopycms/${segs.join('/')}`, body), segs)
      const wallMs = performance.now() - t0
      probe.counting = false
      samples.push({
        label,
        status: res.status,
        wallMs: Math.round(wallMs),
        summary: summaries.join('\n').replace(/^\S+ \[CanopyCMS:timing\] \[DEBUG\] /, ''),
        git: [...probe.git],
        fs: { ...probe.fs },
        paths: probe.paths.map((p) => p.replace(ws, '<ws>')),
      })
      return res
    }

    try {
      for (const who of ['admin', 'editor'] as const) {
        const userId = who === 'admin' ? 'test-admin' : 'editor-1'
        const handler = createCanopyRequestHandler({ services, authPlugin: authPlugin(userId) })
        await run(`${who}:whoami (cold)`, handler, 'GET', ['whoami'])
        await run(`${who}:whoami`, handler, 'GET', ['whoami'])
        await run(`${who}:schema main`, handler, 'GET', ['main', 'schema'])
        await run(`${who}:entries main`, handler, 'GET', ['main', 'entries'])
        if (who === 'admin') {
          await run('admin:create branch', handler, 'POST', ['branches'], {
            branch: 'edit-1',
            title: 'Edit 1',
          })
        }
        for (let i = 0; i < 2; i++) {
          await run(`${who}:schema edit-1 #${i}`, handler, 'GET', ['edit-1', 'schema'])
          await run(`${who}:entries edit-1 #${i}`, handler, 'GET', ['edit-1', 'entries'])
          const read = await run(
            `${who}:content read #${i}`,
            handler,
            'GET',
            ['edit-1', 'content', 'content', 'posts', 'hello-world'],
          )
          const doc = (read.body as { data?: Record<string, unknown> }).data ?? {}
          const saved = await run(
            `${who}:content save #${i}`,
            handler,
            'PUT',
            ['edit-1', 'content', 'content', 'posts', 'hello-world'],
            { format: doc.format, data: doc.data, body: doc.body },
          )
          if (saved.status !== 200) console.error(JSON.stringify(saved.body).slice(0, 300))
          await run(`${who}:comments #${i}`, handler, 'GET', ['edit-1', 'comments'])
          await run(`${who}:branches #${i}`, handler, 'GET', ['branches'])
          await run(`${who}:status #${i}`, handler, 'GET', ['edit-1', 'status'])
        }
      }
      // Concurrency: 4 parallel reads on one handler, spans must not collide.
      const handler = createCanopyRequestHandler({ services, authPlugin: authPlugin('editor-1') })
      summaries.length = 0
      await Promise.all(
        [0, 1, 2, 3].map(() =>
          handler(makeReq('GET', 'http://x/api/canopycms/edit-1/entries'), ['edit-1', 'entries']),
        ),
      )
      const concurrent = [...summaries]
      await fsp.writeFile(OUT, JSON.stringify({ samples, concurrent }, null, 2))
    } finally {
      console.log = origLog
      console.warn = origWarn
      delete process.env.CANOPYCMS_DEBUG
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
```
