#!/usr/bin/env node

/**
 * Build and boot the CMS editor image that `canopycms init-deploy aws` generates, from a fresh
 * app outside this workspace, and assert that it serves real requests.
 *
 *   node scripts/smoke/standalone-image.mjs --pm pnpm            # or --pm npm
 *   node scripts/smoke/standalone-image.mjs --pm npm --tarballs /path/with/tgzs --keep
 *
 * Needs Docker, Node 22+, pnpm (to pack) and, for `--pm pnpm`, corepack. CI runs it as the
 * `standalone-image` job in .github/workflows/ci.yml.
 *
 * Why it exists. Until this job, nothing built `Dockerfile.cms.template`: every test of it was a
 * string match on the generated text, or a CDK synth that stops at staging the build context.
 * Two defects shipped through that gap to the first adopter who built the image. Its builder
 * synthesized a `git init -b main` snapshot that no non-`main` `defaultBaseBranch` could build
 * against. Next's file tracing also left sharp's `libvips-cpp.so` out of `.next/standalone`, so
 * every image operation failed to dlopen at run time.
 *
 * Why the app lives OUTSIDE the workspace and installs `pnpm pack` tarballs. Inside this monorepo
 * the canopycms packages are workspace links compiled through `transpilePackages`, and Next
 * bundles sharp into a server chunk. An adopter's registry install of Next 16 instead
 * externalizes it as `.next/node_modules/sharp-<hash>`, and tracing behaves differently for the
 * two shapes; the libvips defect only shows in the second. `pnpm pack` rather than `npm pack`
 * because only pnpm applies `publishConfig` (the dist/ exports map an adopter actually gets) and
 * rewrites `workspace:` ranges.
 *
 * Why the generated Dockerfile gets one edit. The tarballs are `file:vendor/...` dependencies,
 * and the template's own comment tells an adopter with vendored tarballs to COPY that directory
 * before the install step. The script makes exactly that edit, at that comment, and fails if the
 * comment has moved.
 *
 * Why the container runs in dev mode, with a git checkout copied in before it starts. The
 * template's runner leaves CANOPY_MODE unset (the CDK construct sets prod on Lambda), so the
 * config's `mode: 'dev'` applies. Prod mode would need a credential-verifying auth plugin and an
 * EFS-style workspace, neither of which a CI container has, and the scaffold uses the dev auth
 * plugin. Dev mode serves request-time reads from a branch clone under `/app/.canopy-dev`, seeded
 * from the git repository at the server's cwd (`server.js` chdirs to `/app`). The image has no
 * repository and no content at all (the runner copies only the standalone output), so the
 * script commits the scaffold's `content/` on `release-base` and copies that checkout into
 * `/app` before starting. The runner runs as root, so `/app/.canopy-dev` is writable. That makes
 * every request below exercise the non-`main` base branch at run time too, not just at build.
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** What an adopter using the dev auth provider installs (`canopycms init`'s closing note). */
const PACKAGES = ['canopycms', 'canopycms-next', 'canopycms-auth-dev']

/** Deliberately not `main`: the pre-fix builder could only ever build a `main` base branch. */
const BASE_BRANCH = 'release-base'

const PAGE = {
  slug: 'hello',
  id: 'Smoke1Page2x',
  title: 'Standalone smoke page',
}

/** What the root layout renders around every page, from its own content read. */
const LAYOUT_MARK = `<header>${PAGE.title}</header>`

/** The sitemap's origin. Any absolute URL does; nothing resolves it. */
const SITE_URL = 'https://smoke.canopycms.test'

/** Uploaded, then resized to TRANSFORM_WIDTH, so the transform is a real downscale. */
const UPLOAD = { width: 640, height: 480 }
const TRANSFORM_WIDTH = 160

class SmokeError extends Error {}

function log(message) {
  console.log(`[smoke] ${message}`)
}

function parseOptions() {
  const { values } = parseArgs({
    options: {
      pm: { type: 'string', default: 'pnpm' },
      next: { type: 'string', default: '16.1.7' },
      'pnpm-version': { type: 'string', default: '11.27.0' },
      tarballs: { type: 'string' },
      'work-dir': { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  })
  if (values.pm !== 'pnpm' && values.pm !== 'npm') {
    throw new SmokeError(`--pm must be "pnpm" or "npm", got "${values.pm}"`)
  }
  return {
    pm: values.pm,
    nextVersion: values.next,
    pnpmVersion: values['pnpm-version'],
    tarballDir: values.tarballs ? path.resolve(values.tarballs) : undefined,
    workDir: values['work-dir'] ? path.resolve(values['work-dir']) : undefined,
    keep: values.keep,
  }
}

/**
 * Run a command. Output streams straight through unless `capture` is set, so a failing
 * `docker build` shows its own error in the job log rather than a summary of it.
 */
function run(cmd, args, { cwd, env, capture = false, allowFailure = false } = {}) {
  log(`$ ${[cmd, ...args].join(' ')}${cwd ? `   (in ${cwd})` : ''}`)
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    if (capture) {
      process.stderr.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
    }
    throw new SmokeError(`\`${cmd} ${args.join(' ')}\` exited with status ${result.status}`)
  }
  return result
}

function isInside(child, parent) {
  const rel = path.relative(realpathSync(parent), realpathSync(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function findTarball(dir, pkg) {
  // `canopycms-next-0.0.1.tgz` also starts with `canopycms-`; the version digit disambiguates.
  const matches = readdirSync(dir).filter(
    (file) =>
      file.startsWith(`${pkg}-`) && /^\d/.test(file.slice(pkg.length + 1)) && file.endsWith('.tgz'),
  )
  if (matches.length !== 1) {
    throw new SmokeError(`expected exactly one ${pkg} tarball in ${dir}, found ${matches.length}`)
  }
  return matches[0]
}

/** Pack (or copy in) the tarballs; returns the `file:` specifier for each package. */
function vendorTarballs(vendorDir, tarballDir) {
  mkdirSync(vendorDir, { recursive: true })
  for (const pkg of PACKAGES) {
    if (tarballDir) {
      const file = findTarball(tarballDir, pkg)
      copyFileSync(path.join(tarballDir, file), path.join(vendorDir, file))
    } else {
      // Each package's `prepack` builds it first, exactly as the publish workflow relies on.
      run('pnpm', ['pack', '--pack-destination', vendorDir], {
        cwd: path.join(REPO_ROOT, 'packages', pkg),
      })
    }
  }
  return Object.fromEntries(
    PACKAGES.map((pkg) => [pkg, `file:vendor/${findTarball(vendorDir, pkg)}`]),
  )
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Replace exactly one occurrence of `anchor`, or fail: a moved anchor must not pass silently. */
function patchOnce(file, anchor, replacement) {
  const text = readFileSync(file, 'utf8')
  const count = text.split(anchor).length - 1
  if (count !== 1) {
    throw new SmokeError(
      `${path.basename(file)}: expected exactly one ${JSON.stringify(anchor)}, found ${count}`,
    )
  }
  writeFileSync(file, text.replace(anchor, replacement))
}

/** The package manager as the scaffold's own commands invoke it. */
function packageManager(pm) {
  if (pm === 'npm') {
    return {
      install: ['npm', ['install', '--no-audit', '--no-fund']],
      exec: (bin, args) => ['npm', ['exec', '--no', '--', bin, ...args]],
    }
  }
  // corepack honours the scaffold's `packageManager` field, which is also what the image's
  // `corepack enable && pnpm install` resolves -- so the lockfile is written by the same pnpm
  // that installs from it. Without the field, corepack in the image would take the latest pnpm.
  return {
    install: ['corepack', ['pnpm', 'install']],
    exec: (bin, args) => ['corepack', ['pnpm', 'exec', bin, ...args]],
  }
}

const COREPACK_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }

function scaffold(appDir, options) {
  const { pm, nextVersion, pnpmVersion, tarballDir } = options
  const deps = vendorTarballs(path.join(appDir, 'vendor'), tarballDir)
  const pmCommands = packageManager(pm)

  // A minimal Next 16 app in create-next-app's shape, hand-written rather than generated so the
  // job does not depend on create-next-app's prompts or on next/font fetching Google Fonts.
  writeJson(path.join(appDir, 'package.json'), {
    name: 'canopycms-standalone-smoke',
    version: '0.0.0',
    private: true,
    ...(pm === 'pnpm' ? { packageManager: `pnpm@${pnpmVersion}` } : {}),
    scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    dependencies: {
      ...deps,
      next: nextVersion,
      react: '^19.2.0',
      'react-dom': '^19.2.0',
    },
    devDependencies: {
      '@types/node': '^20',
      '@types/react': '^19',
      '@types/react-dom': '^19',
      typescript: '^5',
    },
  })
  // create-next-app 16.1.7's tsconfig.json, verbatim. Its `**/*.ts` include is what brings the
  // generated infrastructure/ into `next build`'s type-check.
  writeJson(path.join(appDir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2017',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      incremental: true,
      plugins: [{ name: 'next' }],
      paths: { '@/*': ['./*'] },
    },
    include: [
      'next-env.d.ts',
      '**/*.ts',
      '**/*.tsx',
      '.next/types/**/*.ts',
      '.next/dev/types/**/*.ts',
      '**/*.mts',
    ],
    exclude: ['node_modules'],
  })
  if (pm === 'pnpm') {
    // pnpm 11 fails an install that meets a dependency build script with no decision recorded
    // here (ERR_PNPM_IGNORED_BUILDS), and it does not read the `ignoredBuiltDependencies` list
    // create-next-app writes for sharp and unrs-resolver. This dependency tree needs a decision
    // for es5-ext (through the editor) and for sharp (through Next). The image's install must see
    // the same decisions.
    writeText(
      path.join(appDir, 'pnpm-workspace.yaml'),
      ['allowBuilds:', '  es5-ext: true', '  sharp: false', '  unrs-resolver: false', ''].join(
        '\n',
      ),
    )
  }
  // The root layout reads content, so every page renders through a request-scoped read, not-found
  // pages included. An adopter's image with such a layout answered its not-found page and
  // /favicon.ico with 500s, and the not-found checks below assert the layout rendered.
  writeText(
    path.join(appDir, 'app/layout.tsx'),
    [
      "import type { ReactNode } from 'react'",
      "import { readByUrlPath } from './lib/canopy'",
      '',
      'export default async function RootLayout({ children }: { children: ReactNode }) {',
      `  const site = await readByUrlPath<{ title: string }>('/${PAGE.slug}')`,
      '  return (',
      '    <html lang="en">',
      '      <body>',
      '        <header>{site?.data.title}</header>',
      '        {children}',
      '      </body>',
      '    </html>',
      '  )',
      '}',
      '',
    ].join('\n'),
  )
  writeText(
    path.join(appDir, 'app/page.tsx'),
    'export default function Home() {\n  return <main>CanopyCMS standalone image smoke test</main>\n}\n',
  )

  run(...pmCommands.install, { cwd: appDir, env: COREPACK_ENV })
  run(
    ...pmCommands.exec('canopycms', [
      'init',
      '--non-interactive',
      '--auth',
      'dev',
      '--no-dual-build',
      '--no-ai',
      '--app-dir',
      'app',
    ]),
    { cwd: appDir, env: COREPACK_ENV },
  )
  run(...pmCommands.exec('canopycms', ['init-deploy', 'aws', '--non-interactive']), {
    cwd: appDir,
    env: COREPACK_ENV,
  })

  patchOnce(
    path.join(appDir, 'canopycms.config.ts'),
    "  mode: 'dev',\n",
    [
      "  mode: 'dev',",
      `  defaultBaseBranch: '${BASE_BRANCH}',`,
      "  media: { adapter: 'local' },",
      '',
    ].join('\n'),
  )
  // init-deploy's closing note asks for this by hand; the image build sets CANOPY_BUILD=cms.
  patchOnce(
    path.join(appDir, 'next.config.ts'),
    '  // Your Next.js config here\n',
    "  output: process.env.CANOPY_BUILD === 'cms' ? 'standalone' : undefined,\n",
  )
  patchOnce(
    path.join(appDir, 'Dockerfile.cms'),
    '# COPY that directory here, before the install step -- otherwise it fails.\n',
    '# COPY that directory here, before the install step -- otherwise it fails.\nCOPY vendor ./vendor\n',
  )

  writeJson(path.join(appDir, 'content/.collection.json'), {
    entries: [{ name: 'page', label: 'Page', format: 'md', schema: 'page' }],
  })
  writeText(
    path.join(appDir, `content/page.${PAGE.slug}.${PAGE.id}.md`),
    [
      '---',
      `title: ${PAGE.title}`,
      `description: Read at request time from the ${BASE_BRANCH} branch.`,
      '---',
      '',
      'Served by the standalone image smoke test.',
      '',
    ].join('\n'),
  )
  // A dynamic content route in the shape README.md recommends for a CMS server build: render
  // every request live, and let an unknown slug reach notFound().
  writeText(
    path.join(appDir, 'app/[slug]/page.tsx'),
    [
      "import { notFound } from 'next/navigation'",
      "import { readByUrlPath } from '../lib/canopy'",
      "import type { PageContent } from '../schemas'",
      '',
      "export const dynamic = 'force-dynamic'",
      '',
      'export default async function SlugPage({ params }: { params: Promise<{ slug: string }> }) {',
      '  const { slug } = await params',
      '  const result = await readByUrlPath<PageContent>(`/${slug}`)',
      '  if (!result) notFound()',
      '  return (',
      '    <main>',
      '      <h1>{result.data.title}</h1>',
      '      <p>{result.data.description}</p>',
      '    </main>',
      '  )',
      '}',
      '',
    ].join('\n'),
  )

  // The app's build-time content read. A prerendered sitemap is one a CMS server build may make
  // (unlike a prerendered content page, which would serve build-time content past run-time
  // ACLs), and it is where the pre-fix builder failed: `next build` read content through a git
  // snapshot with no `release-base` branch. The helper is README.md's "Sitemap and SEO Metadata".
  const canopyModule = path.join(appDir, 'app/lib/canopy.ts')
  patchOnce(
    canopyModule,
    "type GenerateContentStaticParamsOptions } from 'canopycms-next'",
    "type GenerateContentStaticParamsOptions, type GenerateContentSitemapOptions } from 'canopycms-next'",
  )
  writeText(
    canopyModule,
    [
      readFileSync(canopyModule, 'utf8'),
      'export const contentSitemap = async (options: GenerateContentSitemapOptions) => {',
      '  const context = await canopyContextPromise',
      '  return context.generateContentSitemap(options)',
      '}',
      '',
    ].join('\n'),
  )
  writeText(
    path.join(appDir, 'app/sitemap.ts'),
    [
      "import type { MetadataRoute } from 'next'",
      "import { contentSitemap } from './lib/canopy'",
      '',
      "export const dynamic = 'force-static'",
      '',
      'export default function sitemap(): Promise<MetadataRoute.Sitemap> {',
      `  return contentSitemap({ siteUrl: '${SITE_URL}' })`,
      '}',
      '',
    ].join('\n'),
  )
}

/** A git checkout of the scaffold's content on BASE_BRANCH, for dev mode's run-time reads. */
function seedCheckout(appDir, seedDir) {
  cpSync(path.join(appDir, 'content'), path.join(seedDir, 'content'), { recursive: true })
  const git = (...args) =>
    run(
      'git',
      [
        '-c',
        'user.name=CanopyCMS Smoke',
        '-c',
        'user.email=smoke@canopycms.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: seedDir },
    )
  git('init', '-q', '-b', BASE_BRANCH)
  git('add', 'content')
  git('commit', '-q', '-m', 'Seed content for the standalone image smoke test')
}

async function waitForServer(baseUrl, container) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      await fetch(new URL('/', baseUrl), { redirect: 'manual' })
      return
    } catch {
      // not listening yet
    }
    const running = run('docker', ['inspect', '-f', '{{.State.Running}}', container], {
      capture: true,
    }).stdout.trim()
    if (running !== 'true') throw new SmokeError('the container exited before answering a request')
    await sleep(1000)
  }
  throw new SmokeError('the container did not answer a request within 120s')
}

/** A PNG of `width` x `height` 8-bit RGB pixels, encoded without any image library. */
function encodePng(width, height) {
  if (typeof zlib.crc32 !== 'function') throw new SmokeError('needs Node >= 22.2 (zlib.crc32)')
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([Math.floor((x * 255) / width), 128, 64], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Width and height from a WebP's first chunk, or null when the bytes are not a WebP. */
function webpDimensions(bytes) {
  if (bytes.length < 30) return null
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    return null
  }
  switch (bytes.toString('ascii', 12, 16)) {
    case 'VP8 ':
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    case 'VP8L': {
      const bits = bytes.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    case 'VP8X':
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
    default:
      return null
  }
}

async function request(baseUrl, pathname, init = {}) {
  const response = await fetch(new URL(pathname, baseUrl), { redirect: 'manual', ...init })
  const body = Buffer.from(await response.arrayBuffer())
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', body }
}

function json(response) {
  try {
    return JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new SmokeError(`expected JSON, got ${response.body.toString('utf8').slice(0, 200)}`)
  }
}

/**
 * Runs INSIDE the container: `assertContainer` passes its source to `node -e`, so it can use nothing
 * from this module. Prints, for each `.next/node_modules/sharp-*` alias, the libvips package its
 * sharp declares for this CPU, and what Node's resolution from sharp's own directory finds for it.
 * The image is Debian (glibc), so the package is the `linux` one, not `linuxmusl`.
 */
function describeSharpAliases() {
  const fs = process.getBuiltinModule('node:fs')
  const path = process.getBuiltinModule('node:path')
  const aliasRoot = '/app/.next/node_modules'
  const libvips = `@img/sharp-libvips-linux-${process.arch}`
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
  const aliases = fs.existsSync(aliasRoot)
    ? fs.readdirSync(aliasRoot).filter((name) => name.startsWith('sharp-'))
    : []
  const report = aliases.map((alias) => {
    const sharpDir = fs.realpathSync(path.join(aliasRoot, alias))
    const sharp = readJson(path.join(sharpDir, 'package.json'))
    let found = null
    for (let dir = sharpDir; !found; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', libvips)
      if (
        path.basename(dir) !== 'node_modules' &&
        fs.existsSync(path.join(candidate, 'package.json'))
      ) {
        const libDir = path.join(candidate, 'lib')
        found = {
          dir: candidate,
          version: readJson(path.join(candidate, 'package.json')).version,
          files: fs.existsSync(libDir)
            ? fs.readdirSync(libDir).filter((file) => file.startsWith('libvips-cpp'))
            : [],
        }
      }
      if (path.dirname(dir) === dir) break
    }
    return {
      alias,
      sharpVersion: sharp.version,
      libvips,
      declared: sharp.optionalDependencies?.[libvips] ?? null,
      found,
    }
  })
  console.log(JSON.stringify(report))
}

/**
 * The same one-liner the epic's manual verification ran: require each `.next/node_modules/sharp-*`
 * alias Next emitted, exactly as the server's externalized import resolves it, and encode a PNG.
 */
const SHARP_ALIAS_LOAD =
  "for (const d of require('fs').readdirSync('/app/.next/node_modules').filter(n=>n.startsWith('sharp-'))) require('/app/.next/node_modules/'+d)({create:{width:4,height:4,channels:3,background:'#f00'}}).png().toBuffer().then(b=>console.log(d,b.length))"

async function assertContainer(baseUrl, container) {
  const results = []
  const check = async (name, fn) => {
    try {
      const detail = await fn()
      results.push({ name, ok: true })
      log(`PASS  ${name}${detail ? `: ${detail}` : ''}`)
    } catch (err) {
      results.push({ name, ok: false })
      log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const exec = (args) =>
    run('docker', ['exec', container, ...args], { capture: true, allowFailure: true })

  await check('GET /api/canopycms/whoami answers 200 with a user', async () => {
    const response = await request(baseUrl, '/api/canopycms/whoami')
    if (response.status !== 200) throw new SmokeError(`status ${response.status}`)
    const userId = json(response)?.data?.userId
    if (typeof userId !== 'string' || !userId)
      throw new SmokeError('no data.userId in the response')
    return userId
  })

  await check(
    `GET /${PAGE.slug} renders content read from ${BASE_BRANCH} at request time`,
    async () => {
      const response = await request(baseUrl, `/${PAGE.slug}`)
      if (response.status !== 200) throw new SmokeError(`status ${response.status}`)
      // The page's own heading: the layout's header carries the same title on every page.
      if (!response.body.toString('utf8').includes(`<h1>${PAGE.title}</h1>`)) {
        throw new SmokeError(`status 200, but no <h1>${PAGE.title}</h1>`)
      }
    },
  )

  await check(
    'GET /sitemap.xml lists the content `next build` read from the working tree',
    async () => {
      const response = await request(baseUrl, '/sitemap.xml')
      if (response.status !== 200) throw new SmokeError(`status ${response.status}`)
      const loc = `<loc>${SITE_URL}/${PAGE.slug}</loc>`
      if (!response.body.toString('utf8').includes(loc)) {
        throw new SmokeError(`status 200, but no ${loc}`)
      }
    },
  )

  // The adopter's image answered these with 500s. Three shapes of not-found: an unknown slug
  // reaching the dynamic route's notFound(), a path no route matches, and /favicon.ico (this app
  // ships none).
  for (const [pathname, expectExactly404] of [
    ['/no-such-page', true],
    ['/no/such/route', true],
    ['/favicon.ico', false],
  ]) {
    await check(`GET ${pathname} is ${expectExactly404 ? '404' : 'not a 5xx'}`, async () => {
      const response = await request(baseUrl, pathname)
      const { status } = response
      if (expectExactly404 ? status !== 404 : status >= 500) {
        throw new SmokeError(`status ${status}`)
      }
      if (expectExactly404 && !response.body.toString('utf8').includes(LAYOUT_MARK)) {
        throw new SmokeError(
          `status 404, but not rendered through the root layout (${LAYOUT_MARK})`,
        )
      }
      return `status ${status}`
    })
  }

  const png = encodePng(UPLOAD.width, UPLOAD.height)
  let asset
  await check('POST /api/canopycms/assets/presign returns a proxied upload target', async () => {
    const response = await request(baseUrl, '/api/canopycms/assets/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'smoke.png', contentType: 'image/png', size: png.length }),
    })
    if (response.status !== 200) throw new SmokeError(`status ${response.status}`)
    const mode = json(response)?.data?.upload?.mode
    if (mode !== 'proxied') throw new SmokeError(`upload mode ${JSON.stringify(mode)}`)
  })
  await check('POST /api/canopycms/assets/upload finalizes a raster asset', async () => {
    const form = new FormData()
    form.append('file', new Blob([png], { type: 'image/png' }), 'smoke.png')
    const response = await request(baseUrl, '/api/canopycms/assets/upload', {
      method: 'POST',
      body: form,
    })
    if (response.status !== 200) {
      throw new SmokeError(
        `status ${response.status}: ${response.body.toString('utf8').slice(0, 300)}`,
      )
    }
    const record = json(response)?.data?.asset
    if (record?.kind !== 'raster')
      throw new SmokeError(`asset kind ${JSON.stringify(record?.kind)}`)
    if (record.width !== UPLOAD.width || record.height !== UPLOAD.height) {
      throw new SmokeError(
        `asset is ${record.width}x${record.height}, uploaded ${UPLOAD.width}x${UPLOAD.height}`,
      )
    }
    asset = record
    return asset.src
  })
  await check('GET the asset src serves the original PNG', async () => {
    if (!asset) throw new SmokeError('skipped: the upload failed')
    const response = await request(baseUrl, asset.src)
    if (response.status !== 200) throw new SmokeError(`status ${response.status}`)
    if (!response.contentType.startsWith('image/png')) {
      throw new SmokeError(`content-type ${response.contentType}`)
    }
  })
  await check(`GET a w=${TRANSFORM_WIDTH} WebP transform is resized by sharp`, async () => {
    if (!asset) throw new SmokeError('skipped: the upload failed')
    const transformPath = `/assets/t/w=${TRANSFORM_WIDTH},f=webp/${asset.hash32}/${asset.slug}.webp`
    const response = await request(baseUrl, transformPath)
    if (response.status !== 200) throw new SmokeError(`${transformPath}: status ${response.status}`)
    const size = webpDimensions(response.body)
    if (!size)
      throw new SmokeError(`${transformPath}: body is not a WebP (${response.contentType})`)
    const expectedHeight = (UPLOAD.height * TRANSFORM_WIDTH) / UPLOAD.width
    if (size.width !== TRANSFORM_WIDTH || size.height !== expectedHeight) {
      throw new SmokeError(`${transformPath}: ${size.width}x${size.height}`)
    }
    return `${size.width}x${size.height}`
  })

  let aliases = []
  await check('sharp is externalized as /app/.next/node_modules/sharp-*', async () => {
    const result = exec(['node', '-e', `(${describeSharpAliases})()`])
    if (result.status !== 0) throw new SmokeError(`inspecting the aliases failed: ${result.stderr}`)
    aliases = JSON.parse(result.stdout)
    if (aliases.length === 0) {
      throw new SmokeError(
        'no sharp-* alias: Next bundled sharp into a chunk (or never emitted it), which is not the ' +
          "shape an adopter's registry install builds -- this job would no longer test that shape",
      )
    }
    return aliases.map(({ alias, sharpVersion }) => `${alias} -> sharp@${sharpVersion}`).join(', ')
  })
  // Not "some libvips-cpp exists": Next's own sharp 0.34 brings an older libvips that its tracer
  // already copies, so that would pass with the defect present. The library must be the version
  // the externalized sharp itself declares.
  await check('each sharp alias has its own libvips-cpp in the image', async () => {
    if (aliases.length === 0) throw new SmokeError('skipped: no sharp-* alias')
    const problems = aliases.flatMap(({ alias, libvips, declared, found }) => {
      if (!declared) return [`${alias}: its sharp declares no ${libvips}`]
      if (!found) return [`${alias}: no ${libvips} resolves from its sharp`]
      if (found.version !== declared) {
        return [
          `${alias}: ${libvips}@${found.version} resolves, but its sharp declares ${declared}`,
        ]
      }
      if (found.files.length === 0) return [`${alias}: no libvips-cpp.* in ${found.dir}/lib`]
      return []
    })
    if (problems.length > 0) throw new SmokeError(problems.join('; '))
    return aliases
      .map(({ libvips, found }) => `${libvips}@${found.version}: ${found.files.join(', ')}`)
      .join('; ')
  })
  await check('each sharp alias loads and encodes an image', async () => {
    if (aliases.length === 0) throw new SmokeError('skipped: no sharp-* alias to load')
    const result = exec(['node', '-e', SHARP_ALIAS_LOAD])
    const loaded = result.stdout
      .trim()
      .split('\n')
      .filter((line) => /^sharp-\S+ [1-9]\d*$/.test(line))
    if (result.status !== 0 || loaded.length !== aliases.length) {
      throw new SmokeError(
        `exit ${result.status}, ${loaded.length}/${aliases.length} loaded\n${result.stdout}${result.stderr}`,
      )
    }
    return loaded.join(', ')
  })

  const logs = run('docker', ['logs', container], { capture: true })
  const containerLog = `${logs.stdout}${logs.stderr}`
  await check('container logs contain no ERR_DLOPEN_FAILED', async () => {
    const count = containerLog.split('ERR_DLOPEN_FAILED').length - 1
    if (count !== 0) throw new SmokeError(`${count} occurrence(s)`)
  })
  const dynamicUsage = containerLog.split('DYNAMIC_SERVER_USAGE').length - 1
  log(`info  DYNAMIC_SERVER_USAGE occurrences in container logs: ${dynamicUsage}`)

  return { results, containerLog }
}

async function main() {
  const options = parseOptions()
  const workDir = options.workDir ?? mkdtempSync(path.join(os.tmpdir(), 'canopy-standalone-smoke-'))
  mkdirSync(workDir, { recursive: true })
  if (isInside(workDir, REPO_ROOT)) {
    throw new SmokeError(
      `--work-dir must be outside the repository: inside it the packages resolve as workspace ` +
        `links and sharp is bundled rather than externalized (${workDir})`,
    )
  }
  const appDir = path.join(workDir, 'app')
  if (existsSync(appDir)) throw new SmokeError(`${appDir} already exists; use a fresh --work-dir`)
  log(`work dir: ${workDir}`)

  const label = `${options.pm}-next${options.nextVersion}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
  const image = `canopycms-standalone-smoke:${label}`
  const container = `canopycms-standalone-smoke-${label}-${process.pid}`

  scaffold(appDir, options)
  run('docker', ['build', '--progress=plain', '-f', 'Dockerfile.cms', '-t', image, '.'], {
    cwd: appDir,
  })

  const seedDir = path.join(workDir, 'seed')
  seedCheckout(appDir, seedDir)
  run('docker', ['create', '--name', container, '-p', '127.0.0.1::8080', image])
  let outcome
  try {
    run('docker', ['cp', `${seedDir}/.`, `${container}:/app/`])
    run('docker', ['start', container])
    const port = /127\.0\.0\.1:(\d+)/.exec(
      run('docker', ['port', container, '8080/tcp'], { capture: true }).stdout,
    )?.[1]
    if (!port) throw new SmokeError('could not read the container port mapping')
    const baseUrl = `http://127.0.0.1:${port}`
    await waitForServer(baseUrl, container)
    outcome = await assertContainer(baseUrl, container)
  } finally {
    if (outcome) writeFileSync(path.join(workDir, 'container.log'), outcome.containerLog)
    if (!options.keep) {
      run('docker', ['rm', '-f', container], { capture: true, allowFailure: true })
      run('docker', ['rmi', image], { capture: true, allowFailure: true })
    }
  }

  const failed = outcome.results.filter((result) => !result.ok)
  if (failed.length > 0) {
    const tail = outcome.containerLog.split('\n').slice(-200).join('\n')
    console.error(`\n[smoke] container log (last 200 lines):\n${tail}`)
    console.error(`\n❌ ${failed.length} of ${outcome.results.length} checks failed`)
    process.exit(1)
  }
  console.log(
    `\n✅ all ${outcome.results.length} checks passed (${options.pm}, Next ${options.nextVersion})`,
  )
  if (!options.workDir) rmSync(workDir, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
