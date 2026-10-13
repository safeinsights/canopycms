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
 * Read a UTF-8 file and its mtime from ONE open, or undefined if it does not exist. Only ENOENT
 * is swallowed — a permissions or I/O failure still throws, so a caller cannot mistake
 * "unreadable" for "not there yet".
 *
 * The mtime comes from the open handle, not a path `stat`: opening a file on NFS revalidates its
 * attributes against the server (close-to-open), where a path `stat` can be answered from the
 * client's attribute cache for a file another host has since replaced or deleted. So the mtime
 * and the bytes describe the same file, as the server has it.
 */
export async function readFileWithMtimeIfExists(
  filePath: string,
): Promise<{ content: string; mtimeMs: number } | undefined> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(filePath, 'r')
  } catch (err: unknown) {
    if (isNotFoundError(err)) return undefined
    throw err
  }
  try {
    const { mtimeMs } = await handle.stat()
    return { content: await handle.readFile('utf8'), mtimeMs }
  } finally {
    await handle.close()
  }
}
