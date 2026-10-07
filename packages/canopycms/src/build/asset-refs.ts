/**
 * Collect the asset URLs a static build references, so a release can make them exist first.
 *
 * The public `/assets/t/` path serves only what is stored, and widths are chosen by site code at
 * render time, so build output is the one place every final URL appears. The adopter contract
 * that follows: every `/assets/t/` URL the site can request must appear as text in its build
 * output (see .claude/future-tasks/image-materialization-epic.md).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { ASSET_PREFIXES } from '../assets/asset-prefixes'
import { canonicalizeTransformPath } from '../assets/transform-directives'
import { atomicWriteFile } from '../utils/atomic-write'

/** @internal Written into the scanned directory, so a manifest the adopter builds afterwards covers it. */
export const ASSET_REFS_FILENAME = 'canopy-asset-refs.json'

/** Text outputs a URL can hide in: pages, RSC payloads, data, scripts, styles, sitemaps. */
const SCANNED_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.txt',
  '.rsc',
  '.json',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.xml',
])

/**
 * Anchored on the path, never on an origin or a mount prefix, so whatever precedes `/assets/` —
 * an absolute origin, a basePath, the editor's authenticated prefix — is dropped. The directive
 * and filename classes stop at anything that ends a URL in HTML, JSON, JS or CSS (quotes,
 * whitespace, a backslash escape, parens, query, a srcset comma) and exclude `{`, `}` and `$`,
 * so a URL template in a script never reads as a URL. The hash class admits upper case only so
 * that such a URL is reported rather than skipped.
 */
const URL_STOP = String.raw`\s"'\x60<>()\\/?#&{}$`
// eslint-disable-next-line security/detect-non-literal-regexp -- built from constants above
const TRANSFORM_URL_RE = new RegExp(
  String.raw`/${ASSET_PREFIXES.transform}/([^${URL_STOP}]+)/([a-fA-F0-9]{32})/([^${URL_STOP},]+)`,
  'g',
)
// eslint-disable-next-line security/detect-non-literal-regexp -- built from constants above
const STATIC_URL_RE = new RegExp(
  String.raw`/${ASSET_PREFIXES.public}/([a-fA-F0-9]{32})/([^${URL_STOP},]+)`,
  'g',
)
const STATIC_FILENAME_RE = /^[a-z0-9-]+\.[a-z0-9]{1,10}$/
const HASH32_RE = /^[a-f0-9]{32}$/

const assetRefEntrySchema = z
  .object({
    key: z.string().min(1),
    routes: z.array(z.string()),
    files: z.array(z.string()),
  })
  .strict()

const assetRefsFileSchema = z
  .object({
    version: z.literal(1),
    transforms: z.array(assetRefEntrySchema),
    statics: z.array(assetRefEntrySchema),
  })
  .strict()

/** One stored key a build references, with the output files and page routes that reference it. */
type AssetRefEntry = z.infer<typeof assetRefEntrySchema>

export type AssetRefsFile = z.infer<typeof assetRefsFileSchema>

/** A URL in the output that no stored object can answer. */
export interface AssetRefProblem {
  file: string
  url: string
  error: string
}

/** The output references URLs that cannot be served from the store; nothing was written. */
export class AssetRefsError extends Error {
  constructor(readonly problems: readonly AssetRefProblem[]) {
    super(
      `${problems.length} asset URL(s) in the build output cannot be served from the store:\n` +
        problems.map((p) => `  ${p.file}: ${p.url}\n    ${p.error}`).join('\n'),
    )
    this.name = 'AssetRefsError'
  }
}

export interface CollectAssetRefsResult {
  refs: AssetRefsFile
  /** Absolute path of the refs file written. */
  filePath: string
  scannedFiles: number
}

/** Output-relative POSIX paths of every scanned text file under `root`, sorted. */
async function listScannedFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => rel !== ASSET_REFS_FILENAME)
    .sort()
}

/** The route a static-export HTML file serves (`about/index.html` and `about.html` are `/about`). */
function routeForFile(file: string): string | undefined {
  if (!/\.html?$/.test(file)) return undefined
  const withoutExt = file.replace(/\.html?$/, '')
  const route = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '')
  return `/${route}`
}

/** JSON and JS may escape `/` as `\/` or `/`. */
function unescapeSlashes(text: string): string {
  return text.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/')
}

class RefCollector {
  private readonly entries = new Map<string, { routes: Set<string>; files: Set<string> }>()

  add(key: string, file: string): void {
    const entry = this.entries.get(key) ?? { routes: new Set(), files: new Set() }
    entry.files.add(file)
    const route = routeForFile(file)
    if (route !== undefined) entry.routes.add(route)
    this.entries.set(key, entry)
  }

  toEntries(): AssetRefEntry[] {
    return [...this.entries.keys()].sort().map((key) => {
      const entry = this.entries.get(key)
      return {
        key,
        routes: [...(entry?.routes ?? [])].sort(),
        files: [...(entry?.files ?? [])].sort(),
      }
    })
  }
}

/**
 * Scan `outDir` for `/assets/t/...` transform URLs and `/assets/{hash32}/...` static URLs and
 * write their stored keys to `outDir/canopy-asset-refs.json`, sorted so the same output always
 * yields the same file. Throws `AssetRefsError`, writing nothing, if any transform URL is not in
 * canonical form: the public path stores only canonical keys and computes nothing on a miss.
 */
export async function collectAssetRefs(outDir: string): Promise<CollectAssetRefsResult> {
  const root = path.resolve(outDir)
  const files = await listScannedFiles(root)
  const transforms = new RefCollector()
  const statics = new RefCollector()
  const problems: AssetRefProblem[] = []

  for (const file of files) {
    const text = unescapeSlashes(await fs.readFile(path.join(root, file), 'utf-8'))

    for (const match of text.matchAll(TRANSFORM_URL_RE)) {
      const [url, directives, hash32, filename] = match
      const canonical = canonicalizeTransformPath([directives, hash32, filename])
      if (!canonical.ok) {
        problems.push({ file, url, error: canonical.error })
      } else if (!canonical.isCanonical) {
        problems.push({
          file,
          url,
          error: `Not canonical; assetUrl would write /${ASSET_PREFIXES.transform}/${canonical.canonicalPath}`,
        })
      } else {
        transforms.add(`${ASSET_PREFIXES.transform}/${canonical.canonicalPath}`, file)
      }
    }

    for (const match of text.matchAll(STATIC_URL_RE)) {
      const [url, hash32, filename] = match
      if (!HASH32_RE.test(hash32) || !STATIC_FILENAME_RE.test(filename)) {
        problems.push({ file, url, error: 'Not a stored static asset path' })
      } else {
        statics.add(`${ASSET_PREFIXES.public}/${hash32}/${filename}`, file)
      }
    }
  }

  if (problems.length > 0) throw new AssetRefsError(problems)

  const refs: AssetRefsFile = {
    version: 1,
    transforms: transforms.toEntries(),
    statics: statics.toEntries(),
  }
  const filePath = path.join(root, ASSET_REFS_FILENAME)
  await atomicWriteFile(filePath, `${JSON.stringify(refs, null, 2)}\n`)
  return { refs, filePath, scannedFiles: files.length }
}

/** Read and validate a refs file `collectAssetRefs` wrote. */
export async function readAssetRefsFile(filePath: string): Promise<AssetRefsFile> {
  const raw: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'))
  const parsed = assetRefsFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${filePath} is not a valid asset refs file: ${parsed.error.message}`)
  }
  return parsed.data
}
