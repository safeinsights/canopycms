/**
 * Atomic file write: temp file first, then rename over the target, so the file is never
 * partially written. Prevents the interleaved writes that corrupt files on NFS/EFS.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

export async function atomicWriteFile(
  filePath: string,
  content: string | Buffer | Uint8Array,
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tempPath, content, typeof content === 'string' ? 'utf-8' : undefined)

  try {
    await fs.rename(tempPath, filePath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }
}
