#!/usr/bin/env tsx
/**
 * Migrate from symlink-based IDs to filename-embedded IDs.
 *
 * Process:
 * 1. Read all symlinks from content/_ids_/
 * 2. Build ID→path mapping
 * 3. Rename files to include IDs in filename (using git mv)
 * 4. Delete _ids_/ directory
 * 5. Print summary for git commit
 *
 * Usage:
 *   cd apps/test-app
 *   npx tsx ../../scripts/migrate-to-embedded-ids.ts
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

interface RenameOperation {
  old: string
  new: string
  id: string
}

async function migrate() {
  const contentDir = path.join(process.cwd(), 'content')
  const idsDir = path.join(contentDir, '_ids_')

  // Check if _ids_ directory exists
  try {
    await fs.access(idsDir)
  } catch {
    console.log('✅ No _ids_ directory found. Content may already be migrated.')
    return
  }

  console.log('🔍 Scanning symlinks...')

  const symlinks = await fs.readdir(idsDir)
  const renames: RenameOperation[] = []

  for (const id of symlinks) {
    const symlinkPath = path.join(idsDir, id)

    // Read symlink target
    let target: string
    try {
      target = await fs.readlink(symlinkPath)
    } catch (err) {
      console.log(`⚠️  Skipped (not a symlink): ${id}`)
      continue
    }

    // Resolve to absolute path
    const absoluteTarget = path.resolve(path.dirname(symlinkPath), target)
    const relativePath = path.relative(contentDir, absoluteTarget)

    // Check if target exists
    let stat
    try {
      stat = await fs.stat(absoluteTarget)
    } catch (err) {
      console.log(`⚠️  Skipped (broken symlink): ${relativePath}`)
      continue
    }

    const isDir = stat.isDirectory()
    const dir = path.dirname(relativePath)
    const filename = path.basename(relativePath)

    // Skip metadata files (don't add IDs)
    if (filename.startsWith('.')) {
      console.log(`⏭️  Skipped (metadata): ${relativePath}`)
      continue
    }

    // Check if already has ID embedded
    if (hasEmbeddedId(filename)) {
      console.log(`⏭️  Skipped (already has ID): ${relativePath}`)
      continue
    }

    // Truncate 22-char IDs to 12 chars for new format
    const shortId = id.length === 22 ? id.substring(0, 12) : id

    let newFilename: string
    if (isDir) {
      // Directory: slug → slug.id
      newFilename = `${filename}.${shortId}`
    } else {
      // File: slug.ext → slug.id.ext
      const ext = path.extname(filename)
      const slug = path.basename(filename, ext)
      newFilename = `${slug}.${shortId}${ext}`
    }

    const newPath = path.join(dir, newFilename)
    renames.push({ old: relativePath, new: newPath, id: shortId })
  }

  if (renames.length === 0) {
    console.log('✅ No files need migration.')
    await fs.rm(idsDir, { recursive: true })
    console.log(`🗑️  Deleted: ${path.relative(process.cwd(), idsDir)}`)
    return
  }

  console.log(`\n📝 Found ${renames.length} files to migrate:\n`)

  // Perform renames (sort to handle nested dirs correctly - deepest first)
  renames.sort((a, b) => b.old.length - a.old.length)

  for (const { old, new: newPath } of renames) {
    const oldAbsolute = path.join(contentDir, old)
    const newAbsolute = path.join(contentDir, newPath)

    try {
      // Use git mv to preserve history
      execSync(`git mv "${oldAbsolute}" "${newAbsolute}"`, {
        cwd: process.cwd(),
        stdio: 'pipe',
      })
      console.log(`✅ ${old} → ${newPath}`)
    } catch (err) {
      console.error(`❌ Failed to rename ${old}:`, err)
    }
  }

  // Delete _ids_ directory
  console.log('\n🗑️  Cleaning up...')
  try {
    await fs.rm(idsDir, { recursive: true })
    console.log(`✅ Deleted: ${path.relative(process.cwd(), idsDir)}`)
  } catch (err) {
    console.error(`❌ Failed to delete _ids_ directory:`, err)
  }

  console.log('\n✅ Migration complete!')
  console.log('\n📋 Next steps:')
  console.log('  git add content/')
  console.log('  git commit -m "Migrate to filename-embedded IDs (12 chars)"')
}

/**
 * Check if a filename already has an embedded ID.
 * Pattern: slug.{12-char-id}.ext or slug.{12-char-id}
 */
function hasEmbeddedId(filename: string): boolean {
  const parts = filename.split('.')

  // Files: slug.id.ext
  if (parts.length >= 3) {
    const candidate = parts[parts.length - 2]
    if (isValidId(candidate)) return true
  }

  // Directories: slug.id
  if (parts.length === 2) {
    const candidate = parts[parts.length - 1]
    if (isValidId(candidate)) return true
  }

  return false
}

/**
 * Validate ID format (Base58, 12 or 22 characters).
 * Accepts both for migration purposes.
 */
function isValidId(id: string): boolean {
  return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12,22}$/.test(id)
}

// Run migration
migrate().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
