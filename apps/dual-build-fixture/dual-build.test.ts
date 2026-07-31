/**
 * CI safety net for CanopyCMS's two deploy shapes (README.md "Dual-Build
 * Sites"). This shells out to two real `next build`s -- one per
 * CANOPY_BUILD flavor -- and asserts the properties that actually matter:
 * the static export contains zero editor/Mantine code and no CMS-only
 * routes, the CMS build contains both, and both builds render the same
 * content. A regression in withCanopy()'s pageExtensions handling or the
 * deployedAs auth-gating conditionals should fail one of these tests, not
 * ship silently to an adopter's production build.
 *
 * Both `next build` invocations run once in beforeAll (each takes tens of
 * seconds) and every `it()` below just inspects the resulting file trees --
 * keep it that way rather than re-running builds per-assertion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const NEXT_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'next')
const NEXT_DIR = path.join(APP_DIR, '.next')
const STATIC_NEXT_DIR = path.join(APP_DIR, '.next-static') // .next/'s non-cache contents, relocated here right after the static build, before the CMS build overwrites .next/
const OUT_DIR = path.join(APP_DIR, 'out') // only `output: 'export'` (the static build) ever writes this
const STANDALONE_DIR = path.join(NEXT_DIR, 'standalone') // only `output: 'standalone'` (the CMS build) ever writes this

// The content/home.home.Home1Fixture.json fixture's `message` field. Both
// builds read this same entry (see app/home-content.tsx) -- finding it in
// both outputs is the proof they share one content source, not two drifted
// copies.
const CONTENT_MARKER = 'dual-build-fixture-content-marker'

// Mantine's own CSS custom-property namespace -- verified against the
// installed @mantine/core/styles.css, which contains 1700+ literal
// `--mantine-*` declarations. Used (over, say, grepping for a `mantine-core`
// chunk filename) because webpack/Turbopack chunk names and splitting are
// bundler- and version-dependent, not a stable contract; this prefix is
// Mantine's own public CSS API and appears verbatim in any output that
// pulls in `@mantine/core/styles.css` or its component runtime styles,
// surviving minification because it's data, not a JS identifier that a
// minifier would rename.
const MANTINE_SIGNAL = '--mantine-'

interface BuildResult {
  ok: boolean
  output: string
}

function runNextBuild(flavor: 'static' | 'cms'): BuildResult {
  try {
    const output = execFileSync(NEXT_BIN, ['build'], {
      cwd: APP_DIR,
      env: { ...process.env, CANOPY_BUILD: flavor },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}` }
  }
}

/** Recursively collects every regular file under `dir`, as paths relative to `dir`. Empty array if `dir` doesn't exist. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const results: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        results.push(path.relative(dir, full))
      }
    }
  }
  walk(dir)
  return results
}

/** Files under `dir` (relative paths) whose contents include `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  return listFiles(dir).filter((relPath) =>
    readFileSync(path.join(dir, relPath), 'utf8').includes(needle),
  )
}

let staticBuild: BuildResult
let cmsBuild: BuildResult
let cmsServer: ChildProcessWithoutNullStreams | undefined

/**
 * Asks the OS for an ephemeral port by binding to port 0 and reading back
 * what it picked. A hardcoded port previously bit this suite in exactly the
 * way it's meant to guard against: a leftover `next start` from a prior
 * manual run kept listening on the hardcoded port, so the "fresh" server
 * this test spawned failed to bind (or never got hit at all) while fetch()
 * silently talked to the stale process instead -- a false pass with the
 * broken build never actually exercised. A fresh port each run makes that
 * class of contamination impossible instead of relying on cleanup discipline.
 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (!address || typeof address === 'string') {
        srv.close()
        reject(new Error('Could not determine a free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Polls `url` until it responds, but fails fast (rather than polling out the
 * full timeout) if `child` exits first -- e.g. because the port was taken or
 * the server crashed on startup -- surfacing `log` so the failure names what
 * actually went wrong instead of a generic timeout.
 */
async function waitForServer(
  url: string,
  child: ChildProcessWithoutNullStreams,
  getLog: () => string,
  timeoutMs: number,
): Promise<Response> {
  let exited = false
  child.once('exit', () => {
    exited = true
  })

  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `cms server process exited before it started responding.\nServer log:\n${getLog()}`,
      )
    }
    try {
      return await fetch(url)
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(
    `CMS server at ${url} never came up within ${timeoutMs}ms: ${String(lastError)}\nServer log:\n${getLog()}`,
  )
}

/**
 * Removes everything under .next/ EXCEPT .next/cache -- Next's SWC/webpack
 * compilation cache is safe (and worth keeping) to share across both
 * flavors' builds and across CI runs (see the "Cache Next.js build cache"
 * step in ci.yml), but leftover *output* (.next/server, .next/standalone,
 * manifests) from a previous build must not survive into a fresh build:
 * `next build` is not guaranteed to prune output for routes/pageExtensions
 * that no longer apply, so a stale `.next/server/app/edit` could make the
 * static-build assertions pass for the wrong reason.
 */
function cleanNextOutputKeepCache() {
  if (!existsSync(NEXT_DIR)) return
  for (const entry of readdirSync(NEXT_DIR)) {
    if (entry === 'cache') continue
    rmSync(path.join(NEXT_DIR, entry), { recursive: true, force: true })
  }
}

/** Relocates .next/'s non-cache contents to `destDir`, leaving .next/cache in place for the next build to reuse. */
function moveNextOutputAside(destDir: string) {
  rmSync(destDir, { recursive: true, force: true })
  if (!existsSync(NEXT_DIR)) return
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(NEXT_DIR)) {
    if (entry === 'cache') continue
    renameSync(path.join(NEXT_DIR, entry), path.join(destDir, entry))
  }
}

beforeAll(async () => {
  // Start from a clean slate -- stale out/ or .next-static/ from a previous
  // local run must not leak into assertions.
  rmSync(STATIC_NEXT_DIR, { recursive: true, force: true })
  rmSync(OUT_DIR, { recursive: true, force: true })
  cleanNextOutputKeepCache()

  staticBuild = runNextBuild('static')
  // Both flavors write to .next/ -- relocate the static build's output
  // before the CMS build starts so both are still inspectable afterward.
  // `out/` is untouched by the CMS build (only `output: 'export'` writes
  // it), so it doesn't need the same treatment.
  moveNextOutputAside(STATIC_NEXT_DIR)

  cmsBuild = runNextBuild('cms')
}, 300_000)

afterAll(() => {
  cmsServer?.kill('SIGTERM')
})

describe('static build (CANOPY_BUILD=static)', () => {
  it('builds successfully', () => {
    expect(staticBuild.ok, `static \`next build\` failed:\n${staticBuild.output}`).toBe(true)
  })

  it('produces a real static export, not a server build', () => {
    // output: 'export' semantics: an `out/` directory of prerendered HTML,
    // and no `.next/standalone` (that only exists for output: 'standalone').
    expect(existsSync(OUT_DIR), 'expected out/ to exist after a static export build').toBe(true)
    const htmlFiles = listFiles(OUT_DIR).filter((f) => f.endsWith('.html'))
    expect(
      htmlFiles.length,
      `expected out/ to contain prerendered .html files, found: ${htmlFiles.join(', ')}`,
    ).toBeGreaterThan(0)
    const staticStandalone = path.join(STATIC_NEXT_DIR, 'standalone')
    expect(
      existsSync(staticStandalone),
      'static build produced .next/standalone -- it silently became a server build (output was not "export")',
    ).toBe(false)
  })

  it('emits no editor code or Mantine styles anywhere in the output', () => {
    const hits = filesContaining(OUT_DIR, MANTINE_SIGNAL)
    expect(
      hits,
      `static build leaked editor/Mantine code into: ${hits.join(', ')} -- withCanopy()'s staticBuild pageExtensions did not exclude the CMS-only routes that pull in the editor`,
    ).toEqual([])
  })

  it('excludes /edit and the catch-all API route', () => {
    const files = listFiles(OUT_DIR)
    const editFiles = files.filter((f) => f === 'edit.html' || f.startsWith(`edit${path.sep}`))
    const apiFiles = files.filter((f) => f.includes(`api${path.sep}canopycms`))
    expect(
      editFiles,
      `static export should not contain /edit, found: ${editFiles.join(', ')}`,
    ).toEqual([])
    expect(
      apiFiles,
      `static export should not contain the catch-all API route, found: ${apiFiles.join(', ')}`,
    ).toEqual([])
  })

  it('contains the known content marker (reads the same content as the CMS build)', () => {
    const hits = filesContaining(OUT_DIR, CONTENT_MARKER)
    expect(
      hits.length,
      `expected the content marker "${CONTENT_MARKER}" to appear in the prerendered static export (e.g. index.html); found nowhere under out/`,
    ).toBeGreaterThan(0)
  })
})

describe('cms build (CANOPY_BUILD=cms)', () => {
  it('builds successfully', () => {
    expect(cmsBuild.ok, `cms \`next build\` failed:\n${cmsBuild.output}`).toBe(true)
  })

  it('produces a real server build, not a static export', () => {
    expect(
      existsSync(STANDALONE_DIR),
      'expected .next/standalone after a `output: "standalone"` build -- the cms build did not produce a server build',
    ).toBe(true)
  })

  it('includes /edit and the catch-all API route in the compiled server output', () => {
    const serverAppDir = path.join(NEXT_DIR, 'server', 'app')
    const files = listFiles(serverAppDir)
    const editFiles = files.filter((f) => f.startsWith(`edit${path.sep}`))
    const apiFiles = files.filter((f) => f.includes(`api${path.sep}canopycms`))
    expect(
      editFiles.length,
      `cms build is missing /edit under .next/server/app; found: ${files.join(', ')}`,
    ).toBeGreaterThan(0)
    expect(
      apiFiles.length,
      `cms build is missing the catch-all API route under .next/server/app; found: ${files.join(', ')}`,
    ).toBeGreaterThan(0)
  })

  it('serves the same content as the static build, and answers on /edit and the API route', async () => {
    const port = await getFreePort()
    const origin = `http://127.0.0.1:${port}`

    cmsServer = spawn(NEXT_BIN, ['start', '-p', String(port)], {
      cwd: APP_DIR,
      env: { ...process.env, CANOPY_BUILD: 'cms' },
      stdio: 'pipe',
    })
    let serverLog = ''
    cmsServer.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()))
    cmsServer.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()))

    try {
      const homeRes = await waitForServer(origin, cmsServer, () => serverLog, 20_000)
      const homeBody = await homeRes.text()
      // Dev mode resolves the request-time read against a git branch
      // workspace (see README.md "Branch-first workflow"), which reflects
      // the last commit, not uncommitted local edits. Locally, a WIP
      // change to this fixture (or to content/) that hasn't been
      // committed yet renders "/" as a 500 here -- that's expected, not a
      // build-shape regression; commit (or `canopycms sync push`) and
      // re-run. Surfacing the status/body up front makes that case
      // distinguishable from a genuine "static and cms read different
      // content" failure, which is always a 200 with the wrong body.
      expect(
        homeRes.status,
        `cms server's "/" returned ${homeRes.status}, not 200 -- if this is a local run with uncommitted changes, dev-mode's request-time read resolves against the last commit, not the working tree; commit first and re-run.\nServer log:\n${serverLog}\nBody:\n${homeBody}`,
      ).toBe(200)
      expect(
        homeBody.includes(CONTENT_MARKER),
        `cms server's "/" did not contain the content marker "${CONTENT_MARKER}" -- static and cms builds read different content.\nServer log:\n${serverLog}`,
      ).toBe(true)

      const editRes = await fetch(`${origin}/edit`)
      expect(
        editRes.status,
        `cms server's /edit route did not respond (got ${editRes.status})`,
      ).toBe(200)

      // CanopyCMS's handler itself returns a JSON 404 for an unrecognized
      // sub-path (e.g. /health isn't part of its API surface), so status
      // code alone can't distinguish "route wired up" from "route
      // missing" -- both are 404. Content-type does: Next's own
      // route-not-found fallback (when route.server.ts isn't built in at
      // all) renders its HTML 404 shell, while CanopyCMS's handler always
      // responds JSON. text/html here would mean the catch-all API route
      // never made it into the cms build.
      const apiRes = await fetch(`${origin}/api/canopycms/health`)
      const apiContentType = apiRes.headers.get('content-type') ?? ''
      expect(
        apiContentType,
        `cms server's catch-all API route did not dispatch to CanopyCMS's handler (content-type "${apiContentType}", expected JSON) -- route.server.ts was not built in`,
      ).toContain('application/json')
    } finally {
      cmsServer.kill('SIGTERM')
    }
  }, 30_000)
})
