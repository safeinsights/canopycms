/**
 * CLI command: npx canopycms migrate
 *
 * Converts an existing plain content tree into CanopyCMS conventions:
 * - Entry files:  getting-started.md  →  doc.getting-started.<id>.md
 * - Directories:  guides/            →  guides.<id>/ with a .collection.json
 * - Root:         gets a .collection.json when it holds entry files directly
 *
 * Only files of the chosen format are migrated; everything else (assets,
 * other formats) is left untouched, and directories with no matching content
 * anywhere beneath them are skipped. Already-conforming names are skipped,
 * so re-running is a no-op. Source-specific ordering conventions (e.g.
 * Nextra _meta.json) are out of scope — order defaults to alphabetical.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as p from '@clack/prompts'

import { generateId, isValidId } from '../id'
import { extractIdFromFilename } from '../content-id-index'
import { parseSlug } from '../paths'
import { filePathExists } from '../utils/fs'
import { loadCollectionMetaFiles } from '../schema'
import { getErrorMessage } from '../utils/error'
import { BranchMetadataFileManager } from '../branch-metadata'
import { invalidateBranchContentCaches } from '../content-index-generation'

export const MIGRATE_FORMATS = ['md', 'mdx', 'json', 'yaml'] as const
export type MigrateFormat = (typeof MIGRATE_FORMATS)[number]

export interface MigrateOptions {
  projectDir: string
  /** Content directory relative to projectDir (default: content) */
  contentRoot?: string
  /** Entry type name written into .collection.json and file names (e.g. 'doc') */
  entryType?: string
  /** File format to migrate */
  format?: MigrateFormat
  /** Entry schema registry key written into .collection.json (e.g. 'docSchema') */
  schema?: string
  /** Print the plan without touching anything */
  dryRun?: boolean
  /** Skip the confirmation prompt */
  force?: boolean
}

/** Migration precondition failure — thrown so the CLI exits non-zero. */
export class MigrateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrateError'
  }
}

type MigrateOp =
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'write'; filePath: string; content: string }

/**
 * Normalize a file/directory base name into a slug the whole CMS accepts.
 * Must satisfy parseSlug (/^[a-z0-9][a-z0-9-]*$/) — underscores are NOT allowed:
 * the editor would save them but the public read path (readByUrlPath/read)
 * rejects them, leaving migrated pages unreachable.
 */
export function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'item'
}

/** Slugify and assert the result is valid for the content store — fail the plan, not the tree. */
function toValidSlug(name: string): string {
  const slug = slugifyName(name)
  const parsed = parseSlug(slug)
  if (!parsed.ok) {
    throw new MigrateError(
      `Cannot derive a valid slug from "${name}" (got "${slug}"): ${parsed.error}`,
    )
  }
  return slug
}

/**
 * Already-conforming entry file: {type}.{slug}.{id}.{ext} — requires the full
 * 4-part shape, not just any embedded ID, so a coincidental 12-char Base58
 * segment (e.g. "report.attachments1.md") still gets migrated.
 */
function isConformingEntryFile(fileName: string): boolean {
  const parts = fileName.split('.')
  return parts.length >= 4 && isValidId(parts[parts.length - 2])
}

/** Strip a trailing .<12-char-id> from a directory name, if present. */
function stripDirIdSuffix(dirName: string): string {
  const parts = dirName.split('.')
  if (parts.length === 2 && extractIdFromFilename(dirName)) return parts[0]
  return dirName
}

interface PlanContext {
  entryType: string
  format: MigrateFormat
  schema: string
}

interface DirPlan {
  ops: MigrateOp[]
  /** True when this directory (transitively) contains files of the target format */
  hasContent: boolean
}

/**
 * Plan one directory, depth-first. Ops are ordered so that everything inside a
 * directory (file renames, .collection.json creation, nested dirs) happens
 * before the directory itself is renamed by its parent.
 */
async function planDirectory(dirPath: string, isRoot: boolean, ctx: PlanContext): Promise<DirPlan> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const ops: MigrateOp[] = []
  let hasOwnFiles = false
  let hasContent = false

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    if (entry.isDirectory()) {
      const subPath = path.join(dirPath, entry.name)
      const sub = await planDirectory(subPath, false, ctx)
      if (!sub.hasContent) continue // no target-format content anywhere beneath — leave untouched
      hasContent = true
      ops.push(...sub.ops)
      if (!extractIdFromFilename(entry.name)) {
        const newName = `${toValidSlug(entry.name)}.${generateId()}`
        ops.push({ kind: 'rename', from: subPath, to: path.join(dirPath, newName) })
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1)
      // 'yaml' format also matches the common .yml extension (kept as-is in the rename)
      const matchesFormat = ext === ctx.format || (ctx.format === 'yaml' && ext === 'yml')
      if (!matchesFormat) continue
      hasOwnFiles = true
      hasContent = true
      if (!isConformingEntryFile(entry.name)) {
        const base = entry.name.slice(0, -(ext.length + 1))
        const newName = `${ctx.entryType}.${toValidSlug(base)}.${generateId()}.${ext}`
        ops.push({
          kind: 'rename',
          from: path.join(dirPath, entry.name),
          to: path.join(dirPath, newName),
        })
      }
    }
  }

  // Collection meta: every content-bearing directory becomes a collection.
  // The root only needs one when entry files live directly in it.
  const needsMeta = isRoot ? hasOwnFiles : hasContent
  const metaPath = path.join(dirPath, '.collection.json')
  if (needsMeta && !(await filePathExists(metaPath))) {
    const entryTypeMeta = { name: ctx.entryType, format: ctx.format, schema: ctx.schema }
    const meta = isRoot
      ? { entries: [entryTypeMeta] }
      : { name: toValidSlug(stripDirIdSuffix(path.basename(dirPath))), entries: [entryTypeMeta] }
    ops.push({ kind: 'write', filePath: metaPath, content: JSON.stringify(meta, null, 2) + '\n' })
  }

  return { ops, hasContent }
}

const describeOp = (op: MigrateOp, baseDir: string): string =>
  op.kind === 'rename'
    ? `rename  ${path.relative(baseDir, op.from)} → ${path.basename(op.to)}`
    : `create  ${path.relative(baseDir, op.filePath)}`

/** Run the migrate command. Returns the number of operations applied. */
export async function migrate(options: MigrateOptions): Promise<{ opCount: number }> {
  const { projectDir } = options
  const contentRoot = options.contentRoot || 'content'

  p.intro('CanopyCMS migrate')

  const contentDir = path.join(projectDir, contentRoot)
  if (!(await filePathExists(contentDir))) {
    throw new MigrateError(
      `Content directory not found: ${contentRoot}/ (expected at ${contentDir})`,
    )
  }

  // Resolve entry type / format / schema from flags, prompting for what's missing
  let entryType = options.entryType
  if (!entryType) {
    const result = await p.text({
      message: 'Entry type name (used in file names and .collection.json)?',
      placeholder: 'doc',
      defaultValue: 'doc',
    })
    if (p.isCancel(result)) {
      p.cancel('Migrate cancelled.')
      return { opCount: 0 }
    }
    entryType = result
  }
  // The entry type is interpolated into {type}.{slug}.{id}.{ext} filenames — an
  // invalid value (dots, slashes, uppercase) would corrupt the filename grammar
  // or escape the target directory.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entryType)) {
    throw new MigrateError(
      `Invalid entry type "${entryType}" — use lowercase letters, digits, and hyphens (e.g. "doc").`,
    )
  }

  let format = options.format
  if (format && !MIGRATE_FORMATS.includes(format)) {
    throw new MigrateError(
      `Invalid --format "${format}". Use one of: ${MIGRATE_FORMATS.join(', ')}`,
    )
  }
  if (!format) {
    const result = await p.select({
      message: 'Which file format should be migrated?',
      options: MIGRATE_FORMATS.map((f) => ({ value: f, label: f })),
      initialValue: 'md' as MigrateFormat,
    })
    if (p.isCancel(result)) {
      p.cancel('Migrate cancelled.')
      return { opCount: 0 }
    }
    format = result
  }

  let schema = options.schema
  if (!schema) {
    const result = await p.text({
      message: 'Entry schema registry key (from your schemas.ts)?',
      placeholder: `${entryType}Schema`,
      defaultValue: `${entryType}Schema`,
    })
    if (p.isCancel(result)) {
      p.cancel('Migrate cancelled.')
      return { opCount: 0 }
    }
    schema = result
  }

  const { ops } = await planDirectory(contentDir, true, { entryType, format, schema })

  if (ops.length === 0) {
    p.log.info('Nothing to migrate — content already follows CanopyCMS conventions.')
    p.outro('Done!')
    return { opCount: 0 }
  }

  p.log.step(`Planned ${ops.length} operation(s) in ${contentRoot}/:`)
  for (const op of ops) {
    p.log.info(`  ${describeOp(op, contentDir)}`)
  }

  if (options.dryRun) {
    p.outro('Dry run — nothing was changed.')
    return { opCount: 0 }
  }

  if (!options.force) {
    const confirm = await p.confirm({
      message: `Apply ${ops.length} operation(s)? (renames are not tracked by git automatically)`,
      initialValue: false,
    })
    if (p.isCancel(confirm) || !confirm) {
      p.cancel('Migrate cancelled.')
      return { opCount: 0 }
    }
  }

  for (const op of ops) {
    if (op.kind === 'rename') {
      await fs.rename(op.from, op.to)
    } else {
      await fs.writeFile(op.filePath, op.content, 'utf-8')
    }
  }
  p.log.success(`Applied ${ops.length} operation(s).`)

  // migrate's target (`projectDir`, resolved by walking up from cwd to the
  // nearest canopycms.config.ts — see cli/project-root.ts) is USUALLY the
  // developer's live source repo, not a branch clone: migrate is meant to run
  // once, before any branch workspace has ever been created, converting a
  // plain content tree into CanopyCMS conventions. In that (common) case
  // there is no cached schema/content-index to invalidate, and bumping the
  // markers there would be a no-op nobody reads — no consumer treats the
  // live project root as a cached branchRoot outside build/static mode, which
  // skips the disk cache entirely — and would risk violating the
  // never-write-.canopy-meta-at-the-project-root invariant documented on
  // BranchSchemaCache.
  //
  // But projectDir CAN resolve to an actual branch clone workspace if the CLI
  // happens to be invoked with cwd inside one: branch clones are full git
  // clones (see GitManager.cloneRepo), so they carry their own
  // canopycms.config.ts and satisfy findProjectRoot just as well as the true
  // project root. Guard on that directly — a branch clone always has
  // .canopy-meta/branch.json (BranchMetadataFileManager), the live project
  // root never does — rather than assuming based on how migrate is "usually"
  // invoked.
  if (await BranchMetadataFileManager.loadOnly(projectDir)) {
    await invalidateBranchContentCaches(projectDir)
  }

  // Sanity-check the result: all .collection.json files must parse
  try {
    const result = await loadCollectionMetaFiles(contentDir)
    p.log.success(
      `Validated: ${result.collections.length} collection(s)${result.root ? ' + root' : ''} loaded cleanly.`,
    )
  } catch (err) {
    p.log.error(`Post-migration validation failed: ${getErrorMessage(err)}`)
    throw new MigrateError('Migration applied, but the resulting content tree failed validation.')
  }

  p.log.info(`Next: ensure "${schema}" exists in your schemas.ts entry schema registry.`)
  p.outro('Done!')
  return { opCount: ops.length }
}
