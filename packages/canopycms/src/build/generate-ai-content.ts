/**
 * Static build utility for AI content generation.
 *
 * Writes generated AI content to disk as static files.
 * Used during `npm run build` or via the CLI.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { isNodeError } from '../utils/error'
import { ContentStore } from '../content-store'
import { BranchSchemaCache } from '../branch-schema-cache'
import type { CanopyConfig, FlatSchemaItem } from '../config'
import type { EntrySchemaRegistry } from '../schema/types'
import { generateAIContent } from '../ai/generate'
import { resolveBranchRoot } from '../ai/resolve-branch'
import type { AIContentConfig } from '../ai/types'
import { listEntries } from '../content-listing'
import { assertBuildEntriesValid } from '../static'

/**
 * Bookkeeping record of what the previous run wrote, so a later run can remove files it no
 * longer produces.
 *
 * Deliberately NOT the `manifest.json` that `generateAIContent` emits: that one is a published
 * artifact with a defined shape (`AIManifest`) describing entries, collections and bundles for AI
 * consumers. Overloading it with a build-time file list would change a contract adopters read.
 *
 * Dot-prefixed so it sorts out of the way and reads as machine bookkeeping rather than content.
 */
export const GENERATED_RECORD_FILENAME = '.canopy-generated.json'

interface GeneratedRecord {
  /** Output-dir-relative POSIX paths written by the run that produced this record. */
  files: string[]
}

/** Read the previous run's record. A missing, unreadable or malformed record means "know nothing". */
async function readGeneratedRecord(outputDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(outputDir, GENERATED_RECORD_FILENAME), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('files' in parsed)) return []
    const { files } = parsed as { files: unknown }
    if (!Array.isArray(files)) return []
    return files.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    // Absent (first run), unreadable, or hand-edited into nonsense. Pruning is an optimisation;
    // never fail a build over the bookkeeping file. The cost of not knowing is a stale file, which
    // is exactly the pre-existing behaviour.
    return []
  }
}

async function writeGeneratedRecord(outputDir: string, files: string[]): Promise<void> {
  const record: GeneratedRecord = { files: [...files].sort() }
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(
    path.join(outputDir, GENERATED_RECORD_FILENAME),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf-8',
  )
}

/**
 * Remove directories left empty by a prune, walking up from `startDir` towards `stopAt`.
 *
 * `stopAt` (the output directory) is never removed: the adopter created it, or their framework
 * expects it to exist. Any non-empty directory ends the walk.
 */
async function removeEmptyDirsUpward(startDir: string, stopAt: string): Promise<void> {
  let current = startDir
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      await fs.rmdir(current)
    } catch {
      // ENOTEMPTY (something else lives here) or ENOENT (already gone) — either way, stop.
      return
    }
    current = path.dirname(current)
  }
}

export interface GenerateAIContentFilesOptions {
  config: CanopyConfig
  entrySchemaRegistry: EntrySchemaRegistry
  /** Output directory (e.g., 'public/ai') */
  outputDir: string
  aiConfig?: AIContentConfig
  /** @internal Test-only: pre-resolved schema to bypass BranchSchemaCache */
  _testFlatSchema?: FlatSchemaItem[]
}

/**
 * A `CANOPY_BUILD_ID` usable as a build id: it becomes a single path segment under
 * `_next/static/`, so a value like `heads/main` (what `git describe --all` returns) would nest
 * that directory, and one containing `..` would climb out of it.
 *
 * Deliberately duplicated in `canopycms-next`'s `with-canopy.ts` rather than shared. That file is
 * loaded by `next.config.ts` before any bundler runs, which is why it ships pre-built and imports
 * nothing from this package; importing a constant from here would pull this module's graph —
 * `node:fs` included — into a config file that must be plain executable JavaScript. The two
 * copies must agree, and the tests on both sides assert the same set of values.
 */
const SAFE_BUILD_ID = /^[A-Za-z0-9._-]{1,255}$/

/** The message every rejection uses, so the stated rule and the enforced rule cannot drift. */
const BUILD_ID_RULE = 'must be 1-255 characters of [A-Za-z0-9._-] and not "." or ".."'

function isUsableBuildId(value: string): boolean {
  // `.` and `..` clear the character class but are not names — as a path segment they resolve to
  // the static directory itself or its parent. `a..b` is an ordinary filename and stays allowed.
  // The 255 bound is the same rule: a longer segment fails at `mkdir` with ENAMETOOLONG.
  return SAFE_BUILD_ID.test(value) && value !== '.' && value !== '..'
}

/**
 * What an unusable `SOURCE_DATE_EPOCH` actually costs, which depends on whether a build id is set.
 *
 * Worth spelling out rather than saying "unpinned": with a build id, `generated` is not merely
 * un-pinned but ABSENT, and a field silently vanishing from a published artifact is the outcome an
 * operator most needs told.
 */
function unpinnedConsequence(buildId: string | undefined): string {
  return buildId
    ? 'omitting `generated` from the manifest entirely (a build id is set, so no build clock is recorded).'
    : 'recording the current time in `generated` instead.'
}

/**
 * Resolve the manifest's build stamp from the environment.
 *
 * This lives at the BUILD boundary, not inside `generateAIContent`, because the same generator
 * also serves the runtime route — where a live clock is the correct answer and a
 * `SOURCE_DATE_EPOCH` that happens to be exported in a server environment must not freeze a
 * response's timestamp.
 *
 * `SOURCE_DATE_EPOCH` is the Reproducible Builds convention (decimal seconds since the epoch),
 * kept under its standard name so a harness that already exports it for tar/gzip/rpm gets this
 * for free. `CANOPY_BUILD_ID` is ours: Next has no such variable of its own.
 *
 * That id is validated here against a rule justified by Next's `_next/static/<id>/` layout, even
 * though this module is framework-agnostic. Deliberate: the variable's whole purpose is that the
 * manifest's `buildId` and the framework's build id name the SAME artifact, so a value one reader
 * would reject is not useful to the other. The cost is that a non-Next adopter cannot use, say, an
 * ISO timestamp as a build id — revisit this rule, in both copies, when a second framework lands.
 *
 * Every rejection warns and is ignored rather than failing the build — same stance as
 * `readGeneratedRecord` above. Both variables treat "set but unusable" as a broken pipeline
 * (`SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` with a failing command) and say so, while
 * "unset" is a deliberate opt-out and says nothing.
 *
 * Note what ignoring a bad `SOURCE_DATE_EPOCH` means when a build id IS set: `generatedAt` stays
 * undefined, so `generated` is omitted rather than falling back to a live clock. A bad value must
 * not resurrect a field the adopter's configuration says is meaningless — which is also why that
 * case warns rather than failing silently, since the field simply disappears.
 */
function resolveBuildStamp(): { generatedAt?: string; buildId?: string } {
  // Trimmed and shape-checked with the same rule `withCanopy` applies, so that when an adopter
  // pins BOTH halves of a build the manifest's `buildId` and Next's `_next/static/<id>/` agree.
  // (They are independent readers of one variable: a host-supplied `generateBuildId`, or the CMS
  // flavor of a dual build, can still leave Next on a different id — this only guarantees that
  // the variable itself is read identically.)
  const rawBuildId = process.env.CANOPY_BUILD_ID
  const trimmedBuildId = rawBuildId?.trim()
  let buildId: string | undefined
  if (rawBuildId === undefined) {
    buildId = undefined
  } else if (!trimmedBuildId) {
    console.warn(
      'CanopyCMS: CANOPY_BUILD_ID is set but blank — recording no buildId in the manifest.',
    )
  } else if (!isUsableBuildId(trimmedBuildId)) {
    console.warn(
      `CanopyCMS: ignoring CANOPY_BUILD_ID="${trimmedBuildId}": it ${BUILD_ID_RULE}, so that ` +
        "the manifest's buildId can match the build id Next stores for the same artifact.",
    )
  } else {
    buildId = trimmedBuildId
  }

  const rawEpoch = process.env.SOURCE_DATE_EPOCH
  const trimmedEpoch = rawEpoch?.trim()
  if (rawEpoch !== undefined && !trimmedEpoch) {
    console.warn(`CanopyCMS: SOURCE_DATE_EPOCH is set but blank — ${unpinnedConsequence(buildId)}`)
  }
  if (!trimmedEpoch) return { buildId }

  // Digits only, applied AFTER trimming: surrounding whitespace is a plausible accident in a
  // shell-exported variable and the intent is unambiguous, but `Number('0x10')` also parses and
  // `0x10` is not a SOURCE_DATE_EPOCH. The `Number.isNaN` check below also catches values large
  // enough that `* 1000` overflows the Date range.
  const seconds = /^\d+$/.test(trimmedEpoch) ? Number(trimmedEpoch) : Number.NaN
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) {
    console.warn(
      `CanopyCMS: ignoring SOURCE_DATE_EPOCH="${trimmedEpoch}" (expected decimal seconds since ` +
        `the Unix epoch) — ${unpinnedConsequence(buildId)}`,
    )
    return { buildId }
  }

  return { generatedAt: date.toISOString(), buildId }
}

/**
 * Generate AI content files and write them to disk.
 *
 * Output written by a previous run that this run no longer produces is removed, so a renamed or
 * re-modelled entry does not leave a stale file behind advertising a URL the site no longer
 * serves. Only files recorded by a previous run are eligible for removal — see
 * `GENERATED_RECORD_FILENAME`.
 *
 * @returns Count of files written, count removed, and the output directory.
 */
export async function generateAIContentFiles(
  options: GenerateAIContentFilesOptions,
): Promise<{ fileCount: number; removedCount: number; outputDir: string }> {
  const { config, entrySchemaRegistry, outputDir, aiConfig, _testFlatSchema } = options
  const contentRootName = config.contentRoot || 'content'

  // Resolve branch root
  const branchRoot = await resolveBranchRoot(config)

  // Load schema
  let flatSchema: FlatSchemaItem[]
  if (_testFlatSchema) {
    flatSchema = _testFlatSchema
  } else {
    const schemaCache = new BranchSchemaCache(config.mode)
    const cached = await schemaCache.getSchema(branchRoot, entrySchemaRegistry, contentRootName)
    flatSchema = cached.flatSchema
  }

  // Fail the build on abandoned create-scaffolds (schema-invalid entries) rather than baking them
  // into generated AI content. Unconditional (no isBuildMode gate): this is an explicit build
  // command, not something `next dev` runs incidentally.
  const entriesForValidation = await listEntries(branchRoot, flatSchema, contentRootName)
  assertBuildEntriesValid(entriesForValidation, 'AI content generation')

  // Create store and generate
  const store = new ContentStore(branchRoot, flatSchema, { contentRootName })
  const result = await generateAIContent({
    store,
    flatSchema,
    contentRoot: contentRootName,
    config: aiConfig,
    entryLinkUrl: config.entryLinkUrl,
    ...resolveBuildStamp(),
  })

  // Write files to disk
  const absoluteOutputDir = path.resolve(outputDir) + path.sep

  /** Resolve an output-relative path, refusing anything that escapes the output directory. */
  const resolveOutputPath = (filePath: string): string => {
    const absolutePath = path.resolve(path.join(absoluteOutputDir, filePath))
    // Security: prevent path traversal in output (e.g., malicious bundle names). Applied to
    // RECORDED paths too, not just freshly generated ones — the record is a file on disk that a
    // person or another tool can edit, and it drives deletions.
    if (!absolutePath.startsWith(absoluteOutputDir)) {
      throw new Error(`Path traversal detected in AI content output: ${filePath}`)
    }
    return absolutePath
  }

  const previousFiles = await readGeneratedRecord(absoluteOutputDir)
  const currentFiles = [...result.files.keys()]

  // Record the UNION before writing anything. If the run dies part-way through, the record on disk
  // is a superset of what exists, so the next run still knows to clean up whatever did land. The
  // opposite order would strand partially-written files outside any record, permanently.
  await writeGeneratedRecord(absoluteOutputDir, [...new Set([...previousFiles, ...currentFiles])])

  let fileCount = 0
  for (const [filePath, content] of result.files) {
    const absolutePath = resolveOutputPath(filePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, content, 'utf-8')
    fileCount++
  }

  // Prune what this run no longer produces. Only files a PREVIOUS RUN OF THIS TOOL recorded are
  // eligible: the output directory belongs to the adopter, and a package must not delete things it
  // cannot prove it created. That is also why this is not a `rm -rf` of the directory.
  const currentSet = new Set(currentFiles)
  const stale = previousFiles.filter((filePath) => !currentSet.has(filePath))
  let removedCount = 0
  for (const filePath of stale) {
    const absolutePath = resolveOutputPath(filePath)
    try {
      await fs.unlink(absolutePath)
      removedCount++
    } catch (err) {
      // Already gone (hand-deleted, or a previous partial prune) is success, not failure.
      if (!isNodeError(err) || err.code !== 'ENOENT') throw err
    }
    await removeEmptyDirsUpward(path.dirname(absolutePath), absoluteOutputDir)
  }

  await writeGeneratedRecord(absoluteOutputDir, currentFiles)

  return { fileCount, removedCount, outputDir: absoluteOutputDir }
}
