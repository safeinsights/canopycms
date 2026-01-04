import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Base path for the test-app workspace.
 * With sourceRoot: 'apps/test-app', the .canopycms directory is created under the test-app.
 */
const TEST_APP_ROOT = path.resolve(process.cwd(), 'apps/test-app')

/**
 * Path to the .canopycms/branches directory where local-prod-sim mode stores branches.
 */
const BRANCHES_DIR = path.join(TEST_APP_ROOT, '.canopycms/branches')

/**
 * Get the path to the main branch content directory.
 */
export function getMainBranchPath(): string {
  return path.join(BRANCHES_DIR, 'main')
}

/**
 * Get the path to a content file within the main branch.
 * @param contentPath - Relative path within content/ (e.g., 'home.json')
 */
export function getContentFilePath(contentPath: string): string {
  return path.join(getMainBranchPath(), 'content', contentPath)
}

/**
 * Read and parse a JSON content file from the main branch.
 * @param contentPath - Relative path within content/ (e.g., 'home.json')
 */
export async function readContentFile<T = unknown>(contentPath: string): Promise<T> {
  const filePath = getContentFilePath(contentPath)
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content) as T
}

/**
 * Check if the main branch workspace exists.
 */
export async function workspaceExists(): Promise<boolean> {
  try {
    await fs.access(getMainBranchPath())
    return true
  } catch {
    return false
  }
}

/**
 * Reset the workspace by removing the .canopycms/branches directory.
 * The app will recreate it on next request.
 */
export async function resetWorkspace(): Promise<void> {
  try {
    await fs.rm(BRANCHES_DIR, { recursive: true, force: true })
  } catch {
    // Directory may not exist, that's fine
  }
  // Also remove the remote.git if it exists (forces fresh initialization)
  const remotePath = path.join(TEST_APP_ROOT, '.canopycms/remote.git')
  try {
    await fs.rm(remotePath, { recursive: true, force: true })
  } catch {
    // Directory may not exist, that's fine
  }
}

/**
 * Ensure the main branch workspace is initialized by calling the API.
 * This creates the branch if it doesn't exist.
 * @param baseUrl - Base URL of the test app (e.g., 'http://localhost:5174')
 */
export async function ensureMainBranch(baseUrl: string): Promise<void> {
  // Try to create the main branch - this is idempotent
  const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ branch: 'main' }),
  })

  // 200 = created, or branch already exists with appropriate response
  if (!response.ok) {
    const body = await response.text()
    // Ignore if branch already exists (might return different status codes)
    if (!body.includes('already exists') && response.status !== 409) {
      console.warn(`Warning: ensureMainBranch got status ${response.status}: ${body}`)
    }
  }
}

/**
 * Wait for the workspace to be initialized (main branch exists).
 * Useful after resetWorkspace() when the app needs to recreate it.
 */
export async function waitForWorkspace(timeoutMs = 30000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await workspaceExists()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Workspace not initialized after ${timeoutMs}ms`)
}
