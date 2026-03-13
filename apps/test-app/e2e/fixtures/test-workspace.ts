import fs from 'node:fs/promises'
import path from 'node:path'
import { testLogger as log } from '../../../../packages/canopycms/src/utils/debug'

/**
 * Base path for the test-app workspace.
 * With sourceRoot: 'apps/test-app', the .canopycms directory is created under the test-app.
 */
const TEST_APP_ROOT = path.resolve(process.cwd(), 'apps/test-app')

/**
 * Path to the .canopy-prod-sim/content-branches directory where prod-sim mode stores branches.
 */
const BRANCHES_DIR = path.join(TEST_APP_ROOT, '.canopy-prod-sim/content-branches')

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
  log.time('resetWorkspace')
  log.info('workspace', 'Starting workspace reset')

  try {
    log.debug('workspace', 'Deleting branches directory', { path: BRANCHES_DIR })
    await fs.rm(BRANCHES_DIR, { recursive: true, force: true })
  } catch {
    // Directory may not exist, that's fine
  }

  // Also remove the remote.git if it exists (forces fresh initialization)
  const remotePath = path.join(TEST_APP_ROOT, '.canopy-prod-sim/remote.git')
  try {
    log.debug('workspace', 'Deleting remote.git', { path: remotePath })
    await fs.rm(remotePath, { recursive: true, force: true })
  } catch {
    // Directory may not exist, that's fine
  }

  log.timeEnd('workspace', 'resetWorkspace')
}

/**
 * Ensure the main branch workspace is initialized by calling the API.
 * This creates the branch if it doesn't exist.
 * @param baseUrl - Base URL of the test app (e.g., 'http://localhost:5174')
 */
export async function ensureMainBranch(baseUrl: string): Promise<void> {
  return log.timed('workspace', 'ensureMainBranch', async () => {
    log.info('workspace', 'Ensuring main branch exists', { baseUrl })

    // Try to create the main branch - this is idempotent
    log.debug('workspace', 'Calling create branch API')
    const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ branch: 'main' }),
    })

    log.debug('workspace', 'API response received', {
      ok: response.ok,
      status: response.status,
    })

    // 200 = created, or branch already exists with appropriate response
    if (!response.ok) {
      const body = await response.text()
      // Ignore if branch already exists (might return different status codes)
      if (body.includes('already exists') || response.status === 409) {
        log.debug('workspace', 'Branch already exists (idempotent)')
        // Continue to wait for workspace - it may still be initializing
      } else {
        // Non-idempotent failure: throw error
        log.error('workspace', 'Failed to create main branch', {
          status: response.status,
          body,
        })
        throw new Error(`Failed to ensure main branch: ${response.status} ${body}`)
      }
    }

    // NEW: Wait for workspace to be fully initialized (whether created or already exists)
    log.debug('workspace', 'Waiting for workspace initialization')
    await waitForWorkspace()

    log.debug('workspace', 'Verifying workspace readiness')
    await verifyWorkspaceReady()

    log.info('workspace', 'Main branch ready')
  })
}

/**
 * Wait for the workspace to be initialized (main branch exists).
 * Useful after resetWorkspace() when the app needs to recreate it.
 */
export async function waitForWorkspace(timeoutMs = 30000): Promise<void> {
  log.debug('workspace', 'Waiting for workspace', { timeoutMs })
  const start = Date.now()
  let attempts = 0

  while (Date.now() - start < timeoutMs) {
    attempts++
    if (await workspaceExists()) {
      log.debug('workspace', 'Workspace ready', {
        attempts,
        durationMs: Date.now() - start,
      })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  log.error('workspace', 'Workspace initialization timeout', {
    timeoutMs,
    attempts,
  })
  throw new Error(`Workspace not initialized after ${timeoutMs}ms`)
}

/**
 * Verify workspace is in a valid, ready state before tests proceed.
 */
export async function verifyWorkspaceReady(): Promise<void> {
  // Check 1: Main branch directory exists
  const mainPath = getMainBranchPath()
  try {
    await fs.access(mainPath)
  } catch {
    throw new Error(`Main branch directory does not exist: ${mainPath}`)
  }

  // Check 2: Git repo initialized in main branch
  const gitPath = path.join(mainPath, '.git')
  try {
    await fs.access(gitPath)
  } catch {
    throw new Error(`Git repository not initialized in main branch: ${gitPath}`)
  }

  // Check 3: Remote.git exists and is valid
  const remotePath = path.join(TEST_APP_ROOT, '.canopy-prod-sim/remote.git')
  try {
    await fs.access(path.join(remotePath, 'config'))
    await fs.access(path.join(remotePath, 'HEAD'))
  } catch {
    throw new Error(`Remote.git not properly initialized: ${remotePath}`)
  }
}

/**
 * Wait for a specific branch workspace to be fully initialized.
 * Useful after creating a branch via API.
 */
export async function waitForBranchWorkspace(branchName: string, timeoutMs = 10000): Promise<void> {
  log.debug('workspace', 'Waiting for branch workspace', { branchName, timeoutMs })
  const branchPath = path.join(BRANCHES_DIR, branchName)
  const start = Date.now()
  let attempts = 0

  while (Date.now() - start < timeoutMs) {
    attempts++
    try {
      // Check branch directory exists
      await fs.access(branchPath)
      // Check .git directory exists
      await fs.access(path.join(branchPath, '.git'))
      // Check branch metadata exists (prod-sim stores metadata in .canopy-meta/)
      await fs.access(path.join(branchPath, '.canopy-meta', 'branch.json'))

      log.debug('workspace', 'Branch workspace ready', {
        branchName,
        attempts,
        durationMs: Date.now() - start,
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  log.error('workspace', 'Branch workspace timeout', {
    branchName,
    timeoutMs,
    attempts,
  })
  throw new Error(`Branch workspace not ready after ${timeoutMs}ms: ${branchName}`)
}

/**
 * Create a branch via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to create
 * @param userId - User ID to make the request as (via X-Test-User header)
 * @param options - Optional branch metadata (title, description, access control)
 */
export async function createBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
  options?: {
    title?: string
    description?: string
    access?: {
      allowedUsers?: string[]
      allowedGroups?: string[]
    }
  },
): Promise<Response> {
  log.debug('api', 'Creating branch via API', { branchName, userId })

  const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({
      branch: branchName,
      ...options,
    }),
  })

  // NEW: Wait for branch workspace to be initialized
  if (response.ok) {
    await waitForBranchWorkspace(branchName)
  }

  return response
}

/**
 * Delete a branch via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to delete
 * @param userId - User ID to make the request as
 */
export async function deleteBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/branches/${branchName}`, {
    method: 'DELETE',
    headers: {
      'X-Test-User': userId,
    },
  })
  return response
}

/**
 * Get branch status and metadata via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch
 * @param userId - User ID to make the request as
 */
export async function getBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<any> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}`, {
    method: 'GET',
    headers: {
      'X-Test-User': userId,
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to get branch: ${response.status} ${await response.text()}`)
  }
  return await response.json()
}

/**
 * List all branches via API.
 * @param baseUrl - Base URL of the test app
 * @param userId - User ID to make the request as
 */
export async function listBranchesViaAPI(baseUrl: string, userId: string): Promise<any[]> {
  const response = await fetch(`${baseUrl}/api/canopycms/branches`, {
    method: 'GET',
    headers: {
      'X-Test-User': userId,
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to list branches: ${response.status}`)
  }
  return await response.json()
}

/**
 * Submit a branch for review (creates PR) via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to submit
 * @param userId - User ID to make the request as
 */
export async function submitBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  log.debug('api', 'Submitting branch via API', { branchName, userId })
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const body = await response.text()
    log.error('api', 'Submit failed', {
      branchName,
      status: response.status,
      body,
    })
  } else {
    log.debug('api', 'Submit successful', { branchName })
  }

  return response
}

/**
 * Withdraw a submitted branch via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to withdraw
 * @param userId - User ID to make the request as
 */
export async function withdrawBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/withdraw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })
  return response
}

/**
 * Approve a branch (reviewer action) via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch to approve
 * @param userId - User ID to make the request as (should be reviewer or admin)
 */
export async function approveBranchViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })
  return response
}

/**
 * Request changes on a branch (reviewer action) via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch
 * @param userId - User ID to make the request as (should be reviewer or admin)
 */
export async function requestChangesViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/request-changes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify({}),
  })
  return response
}

/**
 * Update branch access control via API.
 * @param baseUrl - Base URL of the test app
 * @param branchName - Name of the branch
 * @param userId - User ID to make the request as
 * @param access - Access control configuration
 */
export async function updateBranchAccessViaAPI(
  baseUrl: string,
  branchName: string,
  userId: string,
  access: {
    allowedUsers?: string[]
    allowedGroups?: string[]
  },
): Promise<Response> {
  const response = await fetch(`${baseUrl}/api/canopycms/${branchName}/access`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': userId,
    },
    body: JSON.stringify(access),
  })
  return response
}
