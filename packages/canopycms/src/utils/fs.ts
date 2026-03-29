import fs from 'node:fs/promises'
import { isNotFoundError } from './error'

/** Check if a path exists on disk. */
export async function filePathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch (err: unknown) {
    if (isNotFoundError(err)) return false
    throw err
  }
}
