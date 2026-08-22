/**
 * CI safety net for `apps/example1` -- the reference app most doc snippets and
 * e2e expectations are written against, which historically was never built in
 * CI at all (see .claude/future-tasks/resolved/example1-next-build-not-in-ci.md).
 *
 * A green `next build` alone is NOT sufficient evidence that this app works.
 * The incident that motivated this file: re-modelling the `home` entry as a
 * root `index` entry changed its on-disk slug while `app/page.tsx` still read
 * it by the OLD slug. `readByUrlPath('/')` found nothing, `notFound()` fired,
 * and Next happily prerendered the not-found boundary AT `/` -- the build's
 * exit code stayed 0 throughout, and `app/sitemap.ts` kept advertising the
 * entry's old `/home` URL instead of the `/` it was actually supposed to
 * serve. Nothing about "the build succeeded" would have caught either half of
 * that. So this suite runs a real `next build` and asserts on the OUTPUT:
 * the prerendered home page contains real content (not an empty not-found
 * shell), and the sitemap advertises `/` and never the stale `/home`.
 *
 * Duplicate-URL collisions are NOT re-checked here: `app/sitemap.ts`'s
 * `contentSitemap()` call (via `generateContentSitemap` ->
 * `collectRoutableEntries`) and both content routes' `generateStaticParams`
 * (via `contentStaticParams` -> `collectStaticPaths`) already run
 * `assertNoDuplicateUrlPaths` during a normal `next build` -- a real
 * collision throws and fails the build outright, so a build that reaches
 * `it('builds successfully')` below has already cleared that guard. Adding a
 * second, separate check over `listEntries()` here would just re-run a check
 * the build itself cannot skip.
 *
 * IMPORTANT for CI wiring: this app is always `mode: 'dev'` (see
 * canopycms.config.ts), and dev mode's base-branch resolution
 * (`resolveBaseBranch` / `detectHeadBranch` in canopycms's utils/git.ts)
 * falls back to the literal branch name 'main' whenever HEAD is detached --
 * which is exactly what `actions/checkout` leaves it as. That is true even
 * for this BUILD-TIME read (contrary to what you might assume from
 * apps/dual-build-fixture's own CI comment, which only holds for that
 * fixture's separate static-export flavor, which bypasses branch resolution
 * entirely). Verified empirically while writing this suite: under a detached
 * HEAD with a stale local `main` lying around, this exact build silently
 * reproduced BOTH halves of the historical bug -- empty home page AND
 * `/home` in the sitemap -- because it built the CURRENT commit's code
 * against `main`'s (older) content. The CI job that runs `verify:build` MUST
 * attach HEAD to a real branch pointing at the checked-out commit first
 * (`git checkout -B main`, same as apps/dual-build-fixture's "Attach HEAD to
 * a real branch for dev-mode content reads" step) -- otherwise this suite
 * builds the wrong content and its assertions mean nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const NEXT_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'next')
const NEXT_DIR = path.join(APP_DIR, '.next')
const SERVER_APP_DIR = path.join(NEXT_DIR, 'server', 'app')

// This app does not set NEXT_PUBLIC_SITE_URL for its own local/CI smoke
// build, so app/lib/canopy.ts's SITE_URL falls back to this literal (see its
// own doc comment for why that fallback is example-app-only). Duplicated
// here rather than imported so this test does not need to load canopy.ts's
// full CanopyCMS boot sequence just to read a constant.
const SITE_URL = 'http://localhost:3000'

interface BuildResult {
  ok: boolean
  output: string
}

function runNextBuild(): BuildResult {
  try {
    const output = execFileSync(NEXT_BIN, ['build'], {
      cwd: APP_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}` }
  }
}

/**
 * Removes everything under .next/ EXCEPT .next/cache, so a stale prerendered
 * file from a previous local run (or a route removed since) can't make an
 * assertion below pass for the wrong reason, while still letting CI's
 * "Cache Next.js build cache" step speed up the compile.
 */
function cleanNextOutputKeepCache() {
  if (!existsSync(NEXT_DIR)) return
  for (const entry of readdirSync(NEXT_DIR)) {
    if (entry === 'cache') continue
    rmSync(path.join(NEXT_DIR, entry), { recursive: true, force: true })
  }
}

/**
 * The home entry's hero title, read straight from its content file rather
 * than hardcoded -- it doubles as the "home actually rendered" marker below,
 * so a future legitimate copy edit to hero.title doesn't require touching
 * this test, and a renamed/removed root index entry fails loudly here
 * instead of the marker silently never matching anything.
 */
function readHomeHeroTitle(): string {
  const contentDir = path.join(APP_DIR, 'content')
  const homeFile = readdirSync(contentDir).find((f) => /^home\.index\.[^.]+\.json$/.test(f))
  if (!homeFile) {
    throw new Error(
      `Could not find the root home entry (expected a content/home.index.*.json file) under ${contentDir} ` +
        '-- did the home entry stop being a root index entry? See app/page.tsx and app/sitemap.ts for why it should stay one.',
    )
  }
  const data = JSON.parse(readFileSync(path.join(contentDir, homeFile), 'utf8')) as {
    hero?: { title?: unknown }
  }
  const title = data.hero?.title
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error(
      `content/${homeFile} has no hero.title string to use as the home-content marker`,
    )
  }
  return title
}

/** `<loc>` values from a Next sitemap route's emitted XML body. */
function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])
}

let build: BuildResult
let homeHeroTitle: string

beforeAll(() => {
  homeHeroTitle = readHomeHeroTitle()
  cleanNextOutputKeepCache()
  build = runNextBuild()
}, 300_000)

describe('apps/example1 `next build`', () => {
  it('builds successfully', () => {
    expect(build.ok, `\`next build\` failed:\n${build.output}`).toBe(true)
  })

  it('prerenders real home content at "/", not the not-found boundary', () => {
    const indexHtmlPath = path.join(SERVER_APP_DIR, 'index.html')
    expect(
      existsSync(indexHtmlPath),
      `expected a prerendered "/" at ${indexHtmlPath} -- found nothing under .next/server/app`,
    ).toBe(true)

    const html = readFileSync(indexHtmlPath, 'utf8')
    expect(
      html.includes(homeHeroTitle),
      `"/" did not contain the home entry's hero title (${JSON.stringify(homeHeroTitle)}) -- ` +
        "this is exactly how the historical bug looked: the build stays green while readByUrlPath('/') " +
        'resolves nothing and the page renders notFound() instead of the real home entry.',
    ).toBe(true)
  })

  it('sitemap.xml advertises "/" and never the stale "/home"', () => {
    const sitemapPath = path.join(SERVER_APP_DIR, 'sitemap.xml.body')
    expect(
      existsSync(sitemapPath),
      `expected a generated sitemap body at ${sitemapPath} -- found nothing under .next/server/app`,
    ).toBe(true)

    const locs = sitemapLocs(readFileSync(sitemapPath, 'utf8'))

    expect(
      locs,
      `sitemap.xml should advertise the site root (${SITE_URL}/) -- home is modelled as a root ` +
        `index entry precisely so its urlPath IS '/' (see app/sitemap.ts's doc comment); found: ${locs.join(', ')}`,
    ).toContain(`${SITE_URL}/`)

    const staleHomeUrls = locs.filter((loc) => loc === `${SITE_URL}/home`)
    expect(
      staleHomeUrls,
      'sitemap.xml advertises "/home" -- that is the home entry\'s OLD urlPath from before it was ' +
        "modelled as a root index entry. Its presence alongside a missing '/' is the exact stale-sitemap " +
        'half of the historical bug this suite guards against.',
    ).toEqual([])

    // Floor, not an exact count: guards against the sitemap silently going
    // (near-)empty (e.g. a content enumeration that quietly resolves
    // nothing) without being brittle to future content additions/removals.
    // Comfortably below the 12 URLs present when this was written (1 home +
    // 9 docs + 2 posts).
    expect(
      locs.length,
      `sitemap.xml only advertised ${locs.length} URL(s): ${locs.join(', ')} -- expected at least 8`,
    ).toBeGreaterThanOrEqual(8)
  })
})
