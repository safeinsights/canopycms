import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { createServer } from 'node:http'
import {
  APP_NAME_MAX_LENGTH,
  APP_SUMMARY_MAX_LENGTH,
  CANOPY_APP_PERMISSIONS,
  appDescription,
  appJwt,
  appManifest,
  appName,
  appSlug,
  creationForm,
  handOffKey,
  handOffWithRetry,
  manifestPostUrl,
  askLine,
  initGitHubApp,
  parseKeyRetryAnswer,
  pressEnter,
  readbackVerdict,
  resetStdinStateForTesting,
  startCallbackServer,
  type AppTarget,
} from './init-github-app'
import { mockConsole, type MockConsole } from '../test-utils'

const TARGET: AppTarget = { owner: 'an-org', repo: 'a-content-site', isOrganization: true }
const REDIRECT = 'http://127.0.0.1:12345/callback'

function testKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  }) as string
}

describe('the App manifest', () => {
  const manifest = appManifest(TARGET, REDIRECT)

  it('declares exactly the permissions the package needs, and nothing wider', () => {
    // The whole point of the manifest being code: "is this credential wider
    // than intended" has to be answerable from the repository. An exact-equality
    // assertion is deliberate — a subset check would let a permission be added
    // here without anyone noticing.
    expect(manifest.default_permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    })
  })

  it('grants no permission outside contents and pull_requests', () => {
    // `metadata: read` is implied by any repository permission, so it is not a
    // choice. Anything else would be.
    const permissions = manifest.default_permissions as Record<string, string>
    for (const name of Object.keys(permissions)) {
      expect(['contents', 'pull_requests', 'metadata']).toContain(name)
    }
    // The ones a PR bot most plausibly acquires by accident: labels and
    // assignees go through the Issues API, and `workflows` is needed to push
    // anything under .github/workflows. This package does neither.
    expect(permissions.issues).toBeUndefined()
    expect(permissions.workflows).toBeUndefined()
    expect(permissions.administration).toBeUndefined()
    expect(permissions.members).toBeUndefined()
    expect(permissions.organization_administration).toBeUndefined()
  })

  it('supplies redirect_url, which GitHub requires despite documenting it as optional', () => {
    // MEASURED 2026-09-05: the App-creation form refuses a manifest without it
    // ("Error 'redirect_url' wasn't supplied") while the REST documentation
    // lists it as optional. It is also the whole reason the flow is worth
    // using: GitHub redirects there with a code, and the conversion endpoint
    // returns the private key, so it never has to touch disk.
    expect(manifest.redirect_url).toBe(REDIRECT)
  })

  it('subscribes to no events, has an inactive webhook, and is not public', () => {
    // Nothing is ever delivered to this App; it is only ever assumed outward.
    expect(manifest.default_events).toEqual([])
    expect(manifest.public).toBe(false)
    expect(manifest.hook_attributes).toEqual({
      url: 'https://example.invalid/unused',
      active: false,
    })
  })

  it('is named and pointed at the REPOSITORY, because the App is per-site', () => {
    // A shared App would mean one site's leaked key mints writes on another
    // site's repository: the private key is App-level, and installation scoping
    // is a choice the key-holder makes at mint time, not a boundary GitHub
    // enforces. Naming it after the account would suggest the opposite.
    expect(manifest.name).toBe('a-content-site CanopyCMS')
    expect(manifest.url).toBe('https://github.com/an-org/a-content-site')
  })

  it('copies the permission constant rather than aliasing it', () => {
    // The manifest is handed to JSON.stringify and to a browser; a shared
    // reference would let a caller mutate the package's declared desired state.
    const permissions = manifest.default_permissions as Record<string, string>
    expect(permissions).not.toBe(CANOPY_APP_PERMISSIONS)
    expect(permissions).toEqual(CANOPY_APP_PERMISSIONS)
  })

  it('honours an explicit name override', () => {
    expect(appManifest(TARGET, REDIRECT, 'Something Else').name).toBe('Something Else')
  })
})

describe('the App name and description', () => {
  it('fits the measured 34-character name limit for a realistic repository name', () => {
    expect(appName('a-content-site')).toHaveLength(24)
    expect(appName('a-content-site').length).toBeLessThanOrEqual(APP_NAME_MAX_LENGTH)
    expect(APP_NAME_MAX_LENGTH).toBe(34)
  })

  it('derives the slug GitHub derives', () => {
    // The name pre-check compares SLUGS. If this derived differently from
    // GitHub the check would go blind rather than loud.
    expect(appSlug('a-content-site CanopyCMS')).toBe('a-content-site-canopycms')
    expect(appSlug('Foo  Bar/Baz')).toBe('foo-bar-baz')
    expect(appSlug(' Leading & trailing ')).toBe('leading-trailing')
  })

  it('opens with a summary that survives the App list truncating at ~37 characters', () => {
    // MEASURED: the account's App list cuts mid-word at about 37 characters and
    // appears to truncate by CHARACTER, so a newline does not rescue a long
    // opening sentence — only a short one does.
    const summary = appDescription().split('\n')[0]
    expect(summary.length).toBeLessThanOrEqual(APP_SUMMARY_MAX_LENGTH)
    expect(summary).toBe('Commits content edits, opens PRs')
  })

  it('names no adopter, path or site anywhere in the description', () => {
    // The description is stored ON GITHUB, where nothing in this repository can
    // detect it going stale — so it must say only what stays true of the App.
    const description = appDescription()
    expect(description).not.toContain(TARGET.owner)
    expect(description).not.toContain(TARGET.repo)
    expect(description).not.toMatch(/\.ts\b|\/src\/|aws|secrets manager/i)
  })
})

describe('manifestPostUrl', () => {
  it('posts an organisation App to the organisation form', () => {
    expect(manifestPostUrl(TARGET, 'abc')).toBe(
      'https://github.com/organizations/an-org/settings/apps/new?state=abc',
    )
  })

  it('posts a user-account App to the user form', () => {
    // A solo adopter owns the content repository personally. Posting an
    // organisation manifest to the user form (or the reverse) fails at the form.
    expect(manifestPostUrl({ ...TARGET, isOrganization: false }, 'abc')).toBe(
      'https://github.com/settings/apps/new?state=abc',
    )
  })

  it('carries the CSRF state on the action URL, where GitHub echoes it from', () => {
    // In the manifest body it would look implemented and protect nothing.
    const state = 'a state'
    expect(manifestPostUrl(TARGET, state)).toContain('state=a%20state')
    expect(JSON.stringify(appManifest(TARGET, REDIRECT))).not.toContain(state)
  })
})

describe('creationForm', () => {
  it('escapes the manifest so a repository name cannot break out of the attribute', () => {
    const evil = '"><script>alert(1)</script>'
    const html = creationForm(
      manifestPostUrl({ owner: evil, repo: evil, isOrganization: true }, 's'),
      appManifest({ owner: evil, repo: evil, isOrganization: true }, REDIRECT),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapes the action URL as well as the manifest', () => {
    const html = creationForm('https://example.invalid/?a="b"&c=<d>', {})
    expect(html).toContain('action="https://example.invalid/?a=&quot;b&quot;&amp;c=&lt;d&gt;"')
  })
})

describe('appJwt', () => {
  it('signs the shape GitHub accepts, with a backdated iat', () => {
    // Hand-rolled over node:crypto because `.dependency-cruiser.mjs`'s
    // core-no-github-app-auth rule makes @octokit/auth-app a lint error in this
    // package — so the format is ours to get right, and therefore pinned.
    const now = 1_700_000_000
    const jwt = appJwt('123456', testKey(), now)
    const [header, payload, signature] = jwt.split('.')
    expect(jwt.split('.')).toHaveLength(3)
    expect(signature.length).toBeGreaterThan(0)
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(claims.iss).toBe('123456')
    // GitHub rejects a JWT issued in its own future and a second of clock skew
    // between here and GitHub is entirely ordinary.
    expect(claims.iat).toBe(now - 60)
    expect(claims.exp).toBeLessThanOrEqual(now + 600)
    expect(claims.exp).toBeGreaterThan(now)
  })

  it('throws on a key that cannot sign, where the key is', () => {
    expect(() => appJwt('123456', 'not a pem')).toThrow()
  })
})

describe('verify normalises the key the same way the worker does', () => {
  // THE DEFECT: `readBackInstallation` signed with the RAW string `cli.ts`
  // read from `--key-file`/`--key-stdin`, while the worker normalises its own
  // key first (`normalizeGitHubAppPrivateKey`, `worker/github-auth.ts`) --
  // trimming it, unescaping a literal `\n`, and unwrapping a base64-wrapped
  // PEM. `docs/deploying-to-aws.md` documents the worker accepting all of
  // those shapes and tells operators to pipe that exact secret into
  // `verify --key-stdin`, so `verify` used to exit 1 with "could not sign a
  // JWT" on a key the worker boots on fine. MEASURED (reviewer, round 1): raw
  // OK; `\n`-escaped THROWS; base64-wrapped THROWS; leading whitespace
  // THROWS -- all OK after normalisation.
  let consoleSpy: MockConsole

  beforeEach(() => {
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    vi.unstubAllGlobals()
  })

  /**
   * Stubs the four api.github.com calls `readBackInstallation` makes, all
   * succeeding, for one installation holding exactly the permissions this
   * package needs -- so a passing run is unambiguous: exit code 0 with no
   * "could not sign a JWT" / "could not be normalised" line, and that line
   * is the whole thing this test exists to catch a regression in.
   */
  function stubGitHubApi(installationId = 555) {
    const response = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    })
    const fetchMock = vi.fn(async (input: string | URL, init?: { method?: string }) => {
      const url = input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url.endsWith('/repos/an-org/a-content-site/installation')) {
        return response({
          id: installationId,
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          repository_selection: 'selected',
          suspended_at: null,
          app_slug: 'a-content-site-canopycms',
        })
      }
      if (method === 'GET' && url.includes('/app/installations?')) {
        return response([{ id: installationId }])
      }
      if (method === 'POST' && url.endsWith(`/app/installations/${installationId}/access_tokens`)) {
        return response({ token: 'ghs_faketoken' })
      }
      if (method === 'DELETE' && url.endsWith('/installation/token')) {
        return response(undefined, 204)
      }
      throw new Error(`unstubbed request: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  async function verifyWith(privateKey: string): Promise<number> {
    return initGitHubApp({
      mode: 'verify',
      projectDir: '/tmp',
      owner: 'an-org',
      repo: 'a-content-site',
      appId: '123456',
      privateKey,
    })
  }

  it('accepts the raw PEM, as before', async () => {
    stubGitHubApi()
    expect(await verifyWith(testKey())).toBe(0)
  })

  it('accepts a key whose newlines are literal `\\n` escapes', async () => {
    stubGitHubApi()
    const escaped = testKey().trimEnd().replace(/\n/g, '\\n')
    expect(escaped).not.toContain('\n')
    expect(await verifyWith(escaped)).toBe(0)
  })

  it('accepts a base64-wrapped PEM', async () => {
    stubGitHubApi()
    const wrapped = Buffer.from(testKey(), 'utf8').toString('base64')
    expect(wrapped).not.toContain('BEGIN')
    expect(await verifyWith(wrapped)).toBe(0)
  })

  it('accepts a key with surrounding whitespace', async () => {
    stubGitHubApi()
    expect(await verifyWith(`\n  ${testKey().trim()}\n  `)).toBe(0)
  })

  it('still reports the "could not sign a JWT" failure for a key that is not a PEM at all', async () => {
    // The other guidance must survive: a key that parses (once normalised)
    // takes the path above, but garbage that never becomes a PEM must still
    // fail with the ORIGINAL "could not sign a JWT" message pointing at the
    // client-secret mixup -- not the new "could not be normalised" one, since
    // that one is unreachable for the same input (normalisation itself throws
    // first). This pins that `normalizeGitHubAppPrivateKey`'s own error is
    // the one surfaced, distinctly worded from the JWT-signing failure below.
    stubGitHubApi()
    const exitCode = await verifyWith('not a pem at all')
    expect(exitCode).toBe(1)
    expect(consoleSpy).toHaveErrored('could not be normalised')
    expect(consoleSpy.all().error.join('\n')).not.toContain('could not sign a JWT')
  })
})

describe('readbackVerdict', () => {
  const healthy = {
    id: 42,
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    repository_selection: 'selected',
    suspended_at: null,
  }

  it('passes an installation holding exactly what is needed', () => {
    expect(readbackVerdict(healthy)).toEqual([])
  })

  it('reports a missing permission', () => {
    const findings = readbackVerdict({ ...healthy, permissions: { metadata: 'read' } })
    expect(findings.map((f) => f.message).join('\n')).toContain('missing permission contents')
    expect(findings.map((f) => f.message).join('\n')).toContain('missing permission pull_requests')
  })

  it('reports a permission that is present but too weak', () => {
    const findings = readbackVerdict({
      ...healthy,
      permissions: { ...healthy.permissions, pull_requests: 'read' },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('weaker than the required "write"')
  })

  it('reports a permission that is held but NOT needed', () => {
    // The failure that works perfectly and is never noticed. A one-directional
    // check would pass this installation.
    const findings = readbackVerdict({
      ...healthy,
      permissions: { ...healthy.permissions, administration: 'write' },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('administration: write is held but NOT needed')
  })

  it('reports a level STRONGER than required, not just a weaker one', () => {
    // `contents: admin` works perfectly and grants more than this package has
    // any use for — the same failure as an extra permission, and just as
    // invisible. A rank comparison that only looked for "too weak" would pass
    // it.
    const findings = readbackVerdict({
      ...healthy,
      permissions: { ...healthy.permissions, contents: 'admin' },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('STRONGER than the required "write"')
  })

  it('reports an unrecognised level rather than ranking it against known ones', () => {
    // Guessing where a level GitHub adds later sits is how a check quietly
    // starts passing what it was written to catch. It says so instead.
    const findings = readbackVerdict({
      ...healthy,
      permissions: { ...healthy.permissions, contents: 'something-new' },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('not a level this check knows')
  })

  it('reports an installation scoped to every repository in the account', () => {
    const findings = readbackVerdict({ ...healthy, repository_selection: 'all' })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('expected "selected"')
  })

  it('does not read an ABSENT scope as the narrow one', () => {
    // "GitHub did not tell us" is not "selected". Treating it as the narrow
    // value would be the check quietly passing itself.
    const { repository_selection: _omitted, ...withoutScope } = healthy
    const findings = readbackVerdict(withoutScope)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('repository_selection is null')
  })

  it('reports a suspended installation, which no permission change fixes', () => {
    const findings = readbackVerdict({ ...healthy, suspended_at: '2026-09-01T00:00:00Z' })
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain('SUSPENDED')
  })

  it('reports every problem at once rather than stopping at the first', () => {
    const findings = readbackVerdict({
      id: 42,
      permissions: { issues: 'write' },
      repository_selection: 'all',
      suspended_at: '2026-09-01T00:00:00Z',
    })
    // suspended + scope + three missing (contents, pull_requests, metadata)
    // + one extra (issues)
    expect(findings).toHaveLength(6)
    expect(findings.every((f) => f.severity === 'error')).toBe(true)
  })
})

describe('handOffKey', () => {
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n'

  /** A fake child whose stdin and exit behaviour each test chooses. */
  function fakeChild(options: {
    exitCode?: number | null
    stdin?: PassThrough | null
    emitError?: Error
  }) {
    const written: string[] = []
    const child = new EventEmitter() as ChildProcess
    const stdin =
      options.stdin === null
        ? null
        : (options.stdin ??
          (() => {
            const stream = new PassThrough()
            stream.on('data', (chunk: Buffer) => written.push(chunk.toString()))
            return stream
          })())
    // `ChildProcess['stdin']` is `Writable & WritableStream`; a PassThrough is a
    // Writable but not structurally that intersection, so the assignment is
    // narrowed once here rather than at every use.
    child.stdin = stdin as ChildProcess['stdin']
    queueMicrotask(() => {
      if (options.emitError) {
        child.emit('error', options.emitError)
        return
      }
      if (options.exitCode !== undefined) child.emit('close', options.exitCode)
    })
    return { child, written }
  }

  it('writes the key to the child on stdin, never in argv', async () => {
    const { child, written } = fakeChild({ exitCode: 0 })
    let capturedArgs: string[] = []
    const result = await handOffKey(
      PEM,
      { kind: 'command', argv: ['store', '--name', 'k'] },
      (_cmd, args) => {
        capturedArgs = args
        return child
      },
    )
    expect(result.stored).toBe(true)
    expect(written.join('')).toBe(PEM)
    // The key must never reach an argument: arguments are visible in `ps` and
    // land in shell history.
    expect(capturedArgs.join(' ')).not.toContain('PRIVATE KEY')
    expect(capturedArgs).toEqual(['--name', 'k'])
  })

  it('reports NOT stored when the child exits non-zero', async () => {
    // The App already exists at this point, so a false "stored" is the worst
    // possible answer: the operator would never go and generate a fresh key.
    const { child } = fakeChild({ exitCode: 3 })
    const result = await handOffKey(PEM, { kind: 'command', argv: ['store'] }, () => child)
    expect(result.stored).toBe(false)
    expect(result.detail).toContain('exited 3')
  })

  it('survives a child that closes its input early instead of crashing', async () => {
    // Without an 'error' listener on child.stdin an EPIPE is an unhandled
    // stream error, which takes the process down and with it the only copy of
    // the private key.
    const stdin = new PassThrough()
    const { child } = fakeChild({ stdin, exitCode: undefined })
    queueMicrotask(() => {
      stdin.destroy(new Error('EPIPE'))
      // A real child still exits after its pipe breaks, and the exit code is
      // what handOffKey waits for.
      queueMicrotask(() => child.emit('close', 0))
    })
    const result = await handOffKey(PEM, { kind: 'command', argv: ['store'] }, () => child)
    expect(result.stored).toBe(false)
    expect(result.detail).toContain('could not be written to its input')
  })

  it('lets a ZERO exit stand when the key was written cleanly', async () => {
    // The other side of the rule above, and the one that keeps it from being
    // merely conservative: a child that took the key, stored it and exited 0
    // must not be reported as a failure, or the operator generates a new key
    // for nothing.
    const { child, written } = fakeChild({ exitCode: 0 })
    const result = await handOffKey(PEM, { kind: 'command', argv: ['store'] }, () => child)
    expect(result.stored).toBe(true)
    expect(written.join('')).toBe(PEM)
  })

  it('does not let a zero exit override a write that failed', async () => {
    // A write error vetoes a zero exit, and the two are independent events, so
    // the verdict is deferred a turn rather than taken on whichever arrives
    // first. Without that, a broken pipe racing a fast exit reports a key as
    // stored on the strength of an exit code alone.
    const stdin = new PassThrough()
    const { child } = fakeChild({ stdin, exitCode: undefined })
    queueMicrotask(() => {
      stdin.destroy(new Error('EPIPE'))
      queueMicrotask(() => child.emit('close', 0))
    })
    const result = await handOffKey(PEM, { kind: 'command', argv: ['store'] }, () => child)
    expect(result.stored).toBe(false)
  })

  it('takes the exit code as the contract, even from a child that read nothing', async () => {
    // The documented limit, pinned as BEHAVIOUR rather than as a comment, so a
    // future change that starts reporting this as a failure is a deliberate one.
    //
    // MEASURED against real children: `sh -c 'exec 0<&-; exit 0'` and
    // `sh -c 'head -c 5 >/dev/null; exit 0'` both report stored, because a
    // ~1.7KB PEM fits entirely in a 64KB pipe buffer — the write completes into
    // the kernel whether or not the child ever reads it, so no EPIPE is raised
    // and nothing locally distinguishes them from a command that stored the key.
    // The tempting fix (wait for the stream to flush) measures the buffer, not
    // the child, and would look like a check while being one.
    const stdin = new PassThrough()
    stdin.resume() // accepts and discards, exactly as the kernel buffer does
    const { child } = fakeChild({ stdin, exitCode: 0 })
    const result = await handOffKey(PEM, { kind: 'command', argv: ['store'] }, () => child)
    expect(result.stored).toBe(true)
  })

  it('reports a child that could not be spawned at all', async () => {
    const { child } = fakeChild({ emitError: new Error('spawn ENOENT') })
    const result = await handOffKey(PEM, { kind: 'command', argv: ['nope'] }, () => child)
    expect(result.stored).toBe(false)
    expect(result.detail).toContain('could not run `nope`')
  })

  it('reports a child with no stdin rather than hanging', async () => {
    const { child } = fakeChild({ stdin: null, exitCode: undefined })
    const result = await handOffKey(PEM, { kind: 'command', argv: ['store'] }, () => child)
    expect(result.stored).toBe(false)
    expect(result.detail).toContain('no stdin')
  })

  it('writes a file with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canopy-app-key-'))
    const target = join(dir, 'key.pem')
    const result = await handOffKey(PEM, { kind: 'file', filePath: target })
    expect(result.stored).toBe(true)
    expect(await readFile(target, 'utf8')).toBe(PEM)
    // 0o777 masks off the file-type bits; only the permission bits remain.
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('refuses to overwrite an existing file', async () => {
    // Overwriting one credential with another is not a recoverable mistake.
    const dir = await mkdtemp(join(tmpdir(), 'canopy-app-key-'))
    const target = join(dir, 'key.pem')
    await writeFile(target, 'an existing key')
    const result = await handOffKey(PEM, { kind: 'file', filePath: target })
    expect(result.stored).toBe(false)
    expect(result.detail).toContain('already exists')
    expect(await readFile(target, 'utf8')).toBe('an existing key')
  })
})

describe('prompting after stdin has ended', () => {
  // REGRESSION, and the worst outcome this command had. `process.stdin` ends
  // ONCE: a readline interface created after that never emits 'line' or
  // 'close', so a second prompt waits forever. Measured on a real pty as well
  // as a pipe — an operator answering the retry prompt with Ctrl-D ended stdin
  // in `askLine`, the later `pressEnter` never resolved, `createCommand` never
  // returned, and because the exit code is assigned from its result node exited
  // **0** on the one outcome where the App exists and its only key was
  // discarded. The temp directory leaked and the App id — the operator's only
  // handle for generating a replacement key — was never printed.
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  // These prompts print. CI turns any stdout OR stderr from a test into an
  // unhandled rejection, and a local run without `CI=1` shows none of it — so
  // the spy goes in whenever a new test can reach a log line, not only when
  // the code under test is "logging code".
  let consoleSpy: MockConsole

  beforeEach(() => {
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
    resetStdinStateForTesting()
  })

  /** A stdin that is already at end-of-input, as Ctrl-D leaves it. */
  function endedStdin() {
    const stream = new PassThrough()
    stream.end()
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
  }

  it('returns from a SECOND prompt once the first has seen EOF', async () => {
    endedStdin()
    // The first prompt consumes the end-of-input...
    expect(await askLine('first')).toBeNull()
    // ...and the second must still return. Before the fix this never settled,
    // so the test would time out rather than fail.
    await expect(pressEnter('second')).resolves.toBeUndefined()
    // A third, for good measure: the state is sticky, not one-shot.
    expect(await askLine('third')).toBeNull()
  })

  it('still reads a real line when stdin has not ended', async () => {
    // The other direction — the short-circuit must not swallow live input.
    const stream = new PassThrough()
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
    const answer = askLine('type something')
    stream.write('  /tmp/somewhere.pem  \n')
    expect(await answer).toBe('/tmp/somewhere.pem')
  })

  it('marks stdin ended when EOF lands on a line that WAS answered, instead of hanging the next prompt', async () => {
    // THE SECOND DEFECT, subtler than the first: `stdinEnded` used to be set
    // ONLY in the `!answered` branch of `'close'`. Node's readline flushes a
    // pending partial line as a final `'line'` event BEFORE `'close'` when the
    // input ends, so "text then EOF" -- `printf 'abc'` with no trailing
    // newline, or a TTY operator typing text and pressing Ctrl-D twice --
    // answers this prompt normally (`answered` is true) while the stream ALSO
    // finishes in that same moment, and that used to go unrecorded.
    //
    // MEASURED with a scratch driver before the fix: `printf 'abc' | node
    // --import tsx <driver>` printed `first = "abc" stdinEnded = false`, then
    // printed the second prompt and never printed anything after it -- node
    // exiting 0 with the second `askLine` never settling. After the fix, the
    // same input prints `first = "abc" stdinEnded = true` and the second
    // prompt short-circuits to `null` immediately.
    const stream = new PassThrough()
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
    const firstPromise = askLine('first')
    stream.write('abc')
    stream.end() // EOF with NO trailing newline -- the exact shape that hid the bug.
    expect(await firstPromise).toBe('abc')

    // Bounded wait: a regression here HANGS (a readline interface created on
    // an already-ended stream never emits `'line'` or `'close'`), so this must
    // fail the test rather than let the whole suite time out.
    const TIMED_OUT = Symbol('timed out')
    const second = await Promise.race([
      askLine('second'),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
    ])
    expect(second).not.toBe(TIMED_OUT)
    expect(second).toBeNull()
  })
})

describe('parseKeyRetryAnswer', () => {
  // Table test: every rule, in the order the function applies them.
  it.each<[string | null, string]>([
    [null, 'give-up'],
    ['', 'reprompt'],
    ['   ', 'reprompt'],
    ['give up', 'give-up'],
    ['GIVE   up', 'give-up'],
    ['  give up  ', 'give-up'],
    ['|', 'reprompt'],
    ['| pbcopy', 'command'],
    ['pbcopy', 'reprompt'],
    ['wl-copy', 'reprompt'],
    ['./key.pem', 'file'],
    ['dir\\key.pem', 'file'],
    ['aws secretsmanager create-secret --secret-string file:///dev/stdin', 'command'],
    // There is no shell here, so a `|` can never mean "pipe" -- an answer
    // written as a pipeline from habit must be re-prompted, not built into a
    // command that runs `tee`/`aws`/etc. with `|` as an ordinary file name.
    ['tee key.txt | pbcopy', 'reprompt'],
    ['| tee a|b', 'reprompt'],
    ['aws x|y', 'reprompt'],
  ])('routes %j to %s', (answer, expectedKind) => {
    expect(parseKeyRetryAnswer(answer).kind).toBe(expectedKind)
  })

  it('never gives up on a blank line, even though that used to be the rule', () => {
    // THE DEFECT: nothing reads stdin until a readline interface exists, so a
    // stray Enter pressed during the earlier wait sits buffered and is read as
    // the FIRST answer to this prompt. Treating blank as "give up" discarded
    // the only copy of the key without the operator ever seeing the question.
    expect(parseKeyRetryAnswer('')).toEqual({ kind: 'reprompt', reason: 'nothing was entered' })
    expect(parseKeyRetryAnswer('   ')).toEqual({
      kind: 'reprompt',
      reason: 'nothing was entered',
    })
  })

  it('only a closed stdin (null) gives up implicitly', () => {
    expect(parseKeyRetryAnswer(null)).toEqual({ kind: 'give-up' })
  })

  it('treats "give up" as case-insensitive with normalised whitespace', () => {
    expect(parseKeyRetryAnswer('give up')).toEqual({ kind: 'give-up' })
    expect(parseKeyRetryAnswer('GIVE   up')).toEqual({ kind: 'give-up' })
    expect(parseKeyRetryAnswer('  Give Up  ')).toEqual({ kind: 'give-up' })
  })

  it('routes a leading `|` to a command, even for a single word', () => {
    expect(parseKeyRetryAnswer('| pbcopy')).toEqual({ kind: 'command', argv: ['pbcopy'] })
  })

  it('reprompts when nothing follows a lone `|`', () => {
    const result = parseKeyRetryAnswer('|')
    expect(result.kind).toBe('reprompt')
  })

  it('reprompts a one-word answer with no path separator, and writes nothing', () => {
    // THE DEFECT: a bare word used to be routed to `{ kind: 'file' }`, which
    // wrote the PEM to that name in process.cwd() — normally the repo root.
    const result = parseKeyRetryAnswer('pbcopy')
    expect(result).toEqual({
      kind: 'reprompt',
      reason:
        '"pbcopy" could be a file or a command. Enter ./pbcopy to write a file here, ' +
        'or | pbcopy to pipe the key into it.',
    })
  })

  it('routes a single word containing a path separator to a file', () => {
    expect(parseKeyRetryAnswer('./key.pem')).toEqual({ kind: 'file', filePath: './key.pem' })
    expect(parseKeyRetryAnswer('dir\\key.pem')).toEqual({
      kind: 'file',
      filePath: 'dir\\key.pem',
    })
  })

  it('routes two or more tokens to a command, split on whitespace with no shell', () => {
    expect(
      parseKeyRetryAnswer('aws secretsmanager create-secret --secret-string file:///dev/stdin'),
    ).toEqual({
      kind: 'command',
      argv: ['aws', 'secretsmanager', 'create-secret', '--secret-string', 'file:///dev/stdin'],
    })
  })

  it('reprompts a pipeline written from habit, naming there being no shell', () => {
    // THE DEFECT: only a LEADING `|` was special-cased, so a `|` anywhere else
    // was just another argv word to `split(/\s+/)`. `tee key.txt | pbcopy`
    // used to become `{ kind: 'command', argv: ['tee', 'key.txt', '|', 'pbcopy'] }`
    // -- three ordinary file names to `tee`, not a pipe into `pbcopy` -- which
    // `handOffKey` would spawn as `tee key.txt | pbcopy`, writing a 0644 copy
    // of the private key to `key.txt` AND to a file literally named `|` in
    // process.cwd(), while also echoing the PEM to the terminal.
    const result = parseKeyRetryAnswer('tee key.txt | pbcopy')
    expect(result.kind).toBe('reprompt')
    expect((result as { reason: string }).reason).toContain('no shell')
  })

  it('reprompts a `|` embedded in a word even after a leading `|` was stripped', () => {
    // The leading `|` marks "this is a command" and is stripped; a second `|`
    // later in the same answer is still just a word character with no shell to
    // give it meaning.
    expect(parseKeyRetryAnswer('| tee a|b').kind).toBe('reprompt')
  })

  it('reprompts a `|` embedded in a later word of a multi-token command', () => {
    expect(parseKeyRetryAnswer('aws x|y').kind).toBe('reprompt')
  })
})

describe('handOffWithRetry', () => {
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n'
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  const realCwd = process.cwd()
  let consoleSpy: MockConsole

  beforeEach(() => {
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
    resetStdinStateForTesting()
    process.chdir(realCwd)
  })

  /** A live stdin the test can `.write()` lines into. */
  function liveStdin(): PassThrough {
    const stream = new PassThrough()
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true })
    return stream
  }

  it('recovers from a stray blank Enter instead of giving up, and stores the key', async () => {
    // Reproduces the reported failure: the FIRST hand-off fails, the operator's
    // first answer is a blank line (the stray Enter, buffered before this
    // prompt existed), and only the SECOND answer is a real path. Before the
    // fix, the blank line alone was read as "give up" and the key was gone.
    const dir = await mkdtemp(join(tmpdir(), 'canopy-retry-'))
    const badDestination = { kind: 'file' as const, filePath: join(dir, 'missing', 'key.pem') }
    const goodPath = join(dir, 'key.pem')

    const stdin = liveStdin()
    const resultPromise = handOffWithRetry(PEM, badDestination)
    // Let the first (failing) attempt run and the prompt print before answering.
    await new Promise((resolve) => setImmediate(resolve))
    stdin.write('\n')
    await new Promise((resolve) => setImmediate(resolve))
    stdin.write(`${goodPath}\n`)

    const stored = await resultPromise
    expect(stored).toBe(true)
    expect(await readFile(goodPath, 'utf8')).toBe(PEM)
  })

  it('re-prompts on a one-word answer and never writes a file for it', async () => {
    // THE OTHER DEFECT: a one-word answer like `pbcopy` used to be written to
    // that name in process.cwd() — normally the repository root. Chdir into a
    // throwaway directory so a regression would leave file evidence right here
    // rather than in the real repo.
    const dir = await mkdtemp(join(tmpdir(), 'canopy-retry-cwd-'))
    process.chdir(dir)
    const badDestination = { kind: 'file' as const, filePath: join(dir, 'missing', 'key.pem') }
    const goodPath = join(dir, 'key.pem')

    const stdin = liveStdin()
    const resultPromise = handOffWithRetry(PEM, badDestination)
    await new Promise((resolve) => setImmediate(resolve))
    stdin.write('pbcopy\n')
    await new Promise((resolve) => setImmediate(resolve))
    // No file named `pbcopy` must exist in the cwd after that ambiguous answer.
    await expect(readFile(join(dir, 'pbcopy'), 'utf8')).rejects.toThrow()
    stdin.write(`${goodPath}\n`)

    const stored = await resultPromise
    expect(stored).toBe(true)
    await expect(readFile(join(dir, 'pbcopy'), 'utf8')).rejects.toThrow()
    expect(await readFile(goodPath, 'utf8')).toBe(PEM)
  })

  it('re-prompts on a pipeline answer and never spawns it or writes a file for it', async () => {
    // THE THIRD DEFECT: only a LEADING `|` was special-cased, so `tee key.txt |
    // pbcopy` used to become a COMMAND — `tee` with argv `['key.txt', '|',
    // 'pbcopy']` — which `handOffKey` would actually spawn, writing a 0644 copy
    // of the private key to `key.txt` (and to a file literally named `|`) in
    // process.cwd(), while also echoing the PEM to the terminal. Chdir into a
    // throwaway directory for the same reason as the test above: a regression
    // leaves file evidence right here.
    const dir = await mkdtemp(join(tmpdir(), 'canopy-retry-pipe-'))
    process.chdir(dir)
    const badDestination = { kind: 'file' as const, filePath: join(dir, 'missing', 'key.pem') }
    const goodPath = join(dir, 'key.pem')

    const stdin = liveStdin()
    const resultPromise = handOffWithRetry(PEM, badDestination)
    await new Promise((resolve) => setImmediate(resolve))
    stdin.write('tee key.txt | pbcopy\n')
    await new Promise((resolve) => setImmediate(resolve))
    // Neither file `tee` would have written must exist after that answer.
    await expect(readFile(join(dir, 'key.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(dir, '|'), 'utf8')).rejects.toThrow()
    stdin.write(`${goodPath}\n`)

    const stored = await resultPromise
    expect(stored).toBe(true)
    await expect(readFile(join(dir, 'key.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(dir, '|'), 'utf8')).rejects.toThrow()
    expect(await readFile(goodPath, 'utf8')).toBe(PEM)
  })

  it('still gives up when the operator types "give up"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canopy-retry-giveup-'))
    const badDestination = { kind: 'file' as const, filePath: join(dir, 'missing', 'key.pem') }

    const stdin = liveStdin()
    const resultPromise = handOffWithRetry(PEM, badDestination)
    await new Promise((resolve) => setImmediate(resolve))
    stdin.write('give up\n')

    expect(await resultPromise).toBe(false)
  })
})

describe('the loopback callback server', () => {
  async function get(port: number, path: string): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    // Drain, so the socket closes and the server can shut down.
    await response.text()
    return response.status
  }

  it('resolves with the code when the state matches', async () => {
    const state = randomUUID()
    const server = await startCallbackServer(state)
    try {
      expect(await get(server.port, `/callback?state=${state}&code=the-code`)).toBe(200)
      expect(await server.code).toBe('the-code')
    } finally {
      server.close()
    }
  })

  it('ignores a mismatched state AND KEEPS WAITING', async () => {
    // A stray loopback request -- a browser prefetch, an extension, a retried
    // tab -- must not end the run. By this point the App exists and this
    // process is the only thing that will ever hold its key, so aborting over
    // a request that was never GitHub's is unrecoverable.
    const state = randomUUID()
    const server = await startCallbackServer(state)
    try {
      expect(await get(server.port, '/callback?state=wrong&code=attacker')).toBe(400)
      expect(await get(server.port, `/callback?state=${state}&code=the-real-code`)).toBe(200)
      expect(await server.code).toBe('the-real-code')
    } finally {
      server.close()
    }
  })

  it('ignores a request with no code AND KEEPS WAITING', async () => {
    const state = randomUUID()
    const server = await startCallbackServer(state)
    try {
      expect(await get(server.port, `/callback?state=${state}`)).toBe(400)
      expect(await get(server.port, `/callback?state=${state}&code=later`)).toBe(200)
      expect(await server.code).toBe('later')
    } finally {
      server.close()
    }
  })

  it('404s any other path', async () => {
    const server = await startCallbackServer('s')
    try {
      expect(await get(server.port, '/')).toBe(404)
      expect(await get(server.port, '/wp-admin')).toBe(404)
    } finally {
      server.close()
    }
  })

  it('binds loopback only, on an ephemeral port', async () => {
    const server = await startCallbackServer('s')
    try {
      expect(server.port).toBeGreaterThan(0)
    } finally {
      server.close()
    }
  })

  it('rejects when the port cannot be bound, instead of hanging forever', async () => {
    // REGRESSION. Without an 'error' listener on the server, a refused bind is
    // an unhandled 'error' event (which takes the process down) AND the promise
    // never settles either way — so `create` hung rather than saying the port
    // could not be opened. Found by a sandbox that denies listen().
    const failing = new EventEmitter() as unknown as ReturnType<typeof createServer>
    const factory = (() => {
      queueMicrotask(() => failing.emit('error', new Error('listen EPERM')))
      return failing
    }) as unknown as typeof createServer
    // `listen` is never called back, mirroring a real failed bind.
    ;(failing as unknown as { listen: () => void }).listen = () => {}
    await expect(startCallbackServer('s', 1000, factory)).rejects.toThrow(/EPERM/)
  })

  it('rejects on timeout rather than waiting forever', async () => {
    const server = await startCallbackServer('s', 5)
    try {
      await expect(server.code).rejects.toThrow(/timed out/)
    } finally {
      server.close()
    }
  })
})
