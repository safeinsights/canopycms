/**
 * Collect the asset URLs a static build references, so a release can make them exist first.
 *
 * The public `/assets/t/` path serves only what is stored, and widths are chosen by site code at
 * render time, so build output is the one place every final URL appears. The adopter contract
 * that follows: every `/assets/t/` URL the site can request must appear as text in its build
 * output (ARCHITECTURE.md, "Why transform by URL directive and materialize at release?").
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { ASSET_PREFIXES } from '../assets/asset-prefixes'
import { canonicalizeTransformPath } from '../assets/transform-directives'
import { atomicWriteFile } from '../utils/atomic-write'
import { extractInlineFlight } from './inline-flight'

/** @internal Written into the scanned directory, so a manifest the adopter builds afterwards covers it. */
export const ASSET_REFS_FILENAME = 'canopy-asset-refs.json'

/**
 * Text outputs a URL can hide in: pages, RSC payloads, data, scripts, styles, feeds, generated
 * markdown. A file with no extension (a route handler's output) is scanned unless it is binary.
 */
const SCANNED_EXTENSIONS = new Set([
  '',
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
  '.svg',
  '.md',
  '.webmanifest',
])

/**
 * Anchored on the path, never on an origin or a mount prefix, so whatever precedes `/assets/` —
 * an absolute origin, a basePath, the editor's authenticated prefix — is dropped. The directive
 * and filename classes stop at anything that ends a URL in HTML, JSON, JS or CSS (quotes,
 * whitespace, a backslash escape, parens, a query; the filename also at a srcset comma) or at any
 * non-ASCII character (typographic quotes and dashes in prose; no stored key has one), and exclude
 * `{`, `}` and `$`, so a URL template in a script never reads as a URL. A non-ASCII character
 * inside a directive segment therefore ends the match and the URL is not seen. The hash class
 * admits upper case only so that such a URL is reported rather than skipped.
 */
const URL_STOP = String.raw`\s"'\x60<>()\\/?#&{}$\u0080-\uffff`
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

/** A URL in the output that no stored object can answer, or an inline flight script that cannot be read. */
export interface AssetRefProblem {
  file: string
  /** The URL, or the script's position when the problem is a script. */
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

/** Output-relative POSIX paths of every file under `root` with a scanned extension, sorted. */
async function listScannedFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => rel !== ASSET_REFS_FILENAME)
    .sort()
}

const HTML_FILE_RE = /\.html?$/

/** The route a static-export HTML file serves (`about/index.html` and `about.html` are `/about`). */
function routeForFile(file: string): string | undefined {
  if (!HTML_FILE_RE.test(file)) return undefined
  const withoutExt = file.replace(HTML_FILE_RE, '')
  const route = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '')
  return `/${route}`
}

const ENCODED_ASSETS = /%2[fF]assets%2[fF]/g
const RUN_STOP = /[\s"'`<>&]/

/** Each `%XX` escape of an ASCII character, decoded on its own; anything else stays as written. */
function decodeAsciiEscapes(text: string): string {
  return text.replace(/%([0-7][0-9a-fA-F])/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}

/** One malformed or non-UTF-8 escape elsewhere in the run must not hide the URL inside it. */
function decodeOrKeep(run: string): string {
  try {
    return decodeURIComponent(run)
  } catch {
    return decodeAsciiEscapes(run)
  }
}

/**
 * Decode, whole, each percent-encoded run holding an encoded `/assets/` (an image optimizer's
 * `?url=`), so an encoded `%20` or `%3F` after the URL ends it just as a literal one would. Runs are
 * found by expanding outward from each match, so the scan stays linear on long text with no stop
 * character.
 */
function decodeEncodedAssetRuns(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(ENCODED_ASSETS)) {
    if (match.index < last) continue
    let start = match.index
    while (start > last && !RUN_STOP.test(text[start - 1])) start--
    let end = match.index + match[0].length
    while (end < text.length && !RUN_STOP.test(text[end])) end++
    out += text.slice(last, start) + decodeOrKeep(text.slice(start, end))
    last = end
  }
  return out + text.slice(last)
}

/** JSON and JS may escape `/` as a backslash-slash or a `u002F` unicode escape. */
function decodeUrlEscapes(text: string): string {
  return decodeEncodedAssetRuns(text.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/'))
}

/**
 * A slug and ext end in `[a-z0-9]`, so punctuation after a URL in prose is not part of it. Trimmed
 * wherever it occurs: an RSC payload carries prose as JSON strings, where a sentence-final URL is
 * followed by a quote exactly as an attribute value is.
 */
function trimTrailingPunctuation(url: string, filename: string): [string, string] {
  const trimmed = filename.replace(/[.:;!?]+$/, '')
  return [url.slice(0, url.length - (filename.length - trimmed.length)), trimmed]
}

/** A NUL in the first 8 KiB marks a file binary, close to git's own test; only that block is read. */
async function startsBinary(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, 'r')
  try {
    const block = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(block, 0, block.length, 0)
    return block.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
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
 * canonical form or any static URL is malformed: only canonical keys are stored, and the public
 * path is to compute nothing on a miss.
 */
export async function collectAssetRefs(outDir: string): Promise<CollectAssetRefsResult> {
  const root = path.resolve(outDir)
  const files = await listScannedFiles(root)
  const transforms = new RefCollector()
  const statics = new RefCollector()
  const problems: AssetRefProblem[] = []

  const scan = (file: string, raw: string): void => {
    const text = decodeUrlEscapes(raw)
    for (const match of text.matchAll(TRANSFORM_URL_RE)) {
      const [url, filename] = trimTrailingPunctuation(match[0], match[3])
      const [, encodedDirectives, hash32] = match
      // A loader that encodes the directive segment alone is still requesting this key.
      const directives = decodeAsciiEscapes(encodedDirectives)
      const canonical = canonicalizeTransformPath([directives, hash32, filename], 'any')
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
      const [url, filename] = trimTrailingPunctuation(match[0], match[2])
      const hash32 = match[1]
      if (!HASH32_RE.test(hash32) || !STATIC_FILENAME_RE.test(filename)) {
        problems.push({ file, url, error: 'Not a stored static asset path' })
      } else {
        statics.add(`${ASSET_PREFIXES.public}/${hash32}/${filename}`, file)
      }
    }
  }

  let scannedFiles = 0
  for (const file of files) {
    const filePath = path.join(root, file)
    if (path.extname(file) === '' && (await startsBinary(filePath))) continue
    scannedFiles++
    const text = await fs.readFile(filePath, 'utf-8')
    if (!HTML_FILE_RE.test(file)) {
      scan(file, text)
      continue
    }
    // A page's inline RSC payload is split across scripts at arbitrary bytes (inline-flight.ts).
    const page = extractInlineFlight(text)
    scan(file, page.markup)
    for (const flight of page.texts) scan(file, flight)
    for (const { script, error } of page.problems) problems.push({ file, url: script, error })
  }

  if (problems.length > 0) throw new AssetRefsError(problems)

  const refs: AssetRefsFile = {
    version: 1,
    transforms: transforms.toEntries(),
    statics: statics.toEntries(),
  }
  const filePath = path.join(root, ASSET_REFS_FILENAME)
  await atomicWriteFile(filePath, `${JSON.stringify(refs, null, 2)}\n`)
  return { refs, filePath, scannedFiles }
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
