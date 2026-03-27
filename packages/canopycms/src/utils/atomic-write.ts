/**
 * Atomic file write utility.
 *
 * Writes to a temp file first, then renames over the target.
 * Prevents partial/interleaved writes that corrupt files on NFS/EFS.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Atomically write content to a file via temp-file + rename.
 * Ensures the target file is never partially written.
 *
 * @param filePath - Absolute path to the target file
 * @param content - String content to write
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tempPath, content, 'utf-8')

  try {
    await fs.rename(tempPath, filePath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }
}
