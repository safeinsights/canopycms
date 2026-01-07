#!/usr/bin/env tsx
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateId } from '../packages/canopycms/src/id'

/**
 * Migration script to create ID symlinks for all existing entries and collections.
 *
 * This script recursively scans content directories and creates symlinks in
 * a centralized `content/_ids_/` directory for:
 * - Collection directories (e.g., `_ids_/abc123 → ../posts`)
 * - Entry files (e.g., `_ids_/def456 → ../posts/hello.json`)
 *
 * Usage:
 *   npx tsx scripts/create-id-symlinks.ts <content-root>
 *
 * Example:
 *   npx tsx scripts/create-id-symlinks.ts apps/test-app/content
 *   npx tsx scripts/create-id-symlinks.ts packages/canopycms/examples/one/content
 */

interface MigrationStats {
  collectionsProcessed: number
  entriesProcessed: number
  symlinksCreated: number
  errors: Array<{ path: string; error: string }>
}

async function processDirectory(
  dirPath: string,
  idsDir: string,
  stats: MigrationStats
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    stats.errors.push({
      path: dirPath,
      error: `Failed to read directory: ${err}`
    })
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)

    // Skip existing symlinks
    if (entry.isSymbolicLink()) {
      continue
    }

    // Skip hidden files/directories and _ids_ directory
    if (entry.name.startsWith('.') || entry.name === '_ids_') {
      continue
    }

    if (entry.isDirectory()) {
      // Create symlink for collection directory in _ids_
      try {
        const id = generateId()
        const symlinkPath = path.join(idsDir, id)
        const target = path.relative(idsDir, fullPath)
        await fs.symlink(target, symlinkPath, 'dir')
        stats.symlinksCreated++
        stats.collectionsProcessed++
        console.log(`✓ Collection: ${path.relative(process.cwd(), fullPath)} → ${id}`)
      } catch (err) {
        stats.errors.push({
          path: fullPath,
          error: `Failed to create collection symlink: ${err}`
        })
      }

      // Recurse into subdirectory
      await processDirectory(fullPath, idsDir, stats)
    } else if (entry.isFile()) {
      // Only process content files (.json, .md, .mdx)
      const ext = path.extname(entry.name)
      if (!['.json', '.md', '.mdx'].includes(ext)) {
        continue
      }

      // Create symlink for entry file in _ids_
      try {
        const id = generateId()
        const symlinkPath = path.join(idsDir, id)
        const target = path.relative(idsDir, fullPath)
        await fs.symlink(target, symlinkPath, 'file')
        stats.symlinksCreated++
        stats.entriesProcessed++
        console.log(`✓ Entry: ${path.relative(process.cwd(), fullPath)} → ${id}`)
      } catch (err) {
        stats.errors.push({
          path: fullPath,
          error: `Failed to create entry symlink: ${err}`
        })
      }
    }
  }
}

async function main() {
  const contentRoot = process.argv[2]

  if (!contentRoot) {
    console.error('Usage: npx tsx scripts/create-id-symlinks.ts <content-root>')
    console.error('')
    console.error('Example:')
    console.error('  npx tsx scripts/create-id-symlinks.ts apps/test-app/content')
    console.error('  npx tsx scripts/create-id-symlinks.ts packages/canopycms/examples/one/content')
    process.exit(1)
  }

  const absoluteRoot = path.resolve(contentRoot)

  // Verify directory exists
  try {
    const stat = await fs.stat(absoluteRoot)
    if (!stat.isDirectory()) {
      console.error(`Error: ${contentRoot} is not a directory`)
      process.exit(1)
    }
  } catch (err) {
    console.error(`Error: ${contentRoot} does not exist`)
    process.exit(1)
  }

  console.log(`Creating ID symlinks for: ${absoluteRoot}\n`)

  // Create _ids_ directory
  const idsDir = path.join(absoluteRoot, '_ids_')
  await fs.mkdir(idsDir, { recursive: true })

  const stats: MigrationStats = {
    collectionsProcessed: 0,
    entriesProcessed: 0,
    symlinksCreated: 0,
    errors: []
  }

  await processDirectory(absoluteRoot, idsDir, stats)

  console.log('\n' + '='.repeat(60))
  console.log('Migration Complete')
  console.log('='.repeat(60))
  console.log(`Collections processed: ${stats.collectionsProcessed}`)
  console.log(`Entries processed: ${stats.entriesProcessed}`)
  console.log(`Total symlinks created: ${stats.symlinksCreated}`)

  if (stats.errors.length > 0) {
    console.log(`\nErrors encountered: ${stats.errors.length}`)
    for (const err of stats.errors) {
      console.log(`  - ${err.path}: ${err.error}`)
    }
    process.exit(1)
  }

  console.log('\nNext steps:')
  console.log('  git add .')
  console.log('  git status  # Review the new symlinks')
  console.log('  git commit -m "Add ID symlinks for entries and collections"')
}

main()
