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

/**
 * Read a UTF-8 file, or return undefined if it does not exist.
 *
 * Only ENOENT is swallowed — a permissions or I/O failure still throws, so a caller cannot
 * mistake "unreadable" for "not there yet".
 */
export async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err: unknown) {
    if (isNotFoundError(err)) return undefined
    throw err
  }
}
