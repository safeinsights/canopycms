import { vi } from 'vitest'
import type { ApiContext } from '../api/types'
import type { BranchContext, BranchStatus, BranchAccessControl } from '../types'
import type { CanopyServices } from '../services'
import type { CanopyUser } from '../user'
import type { CanopyConfig, PathPermission } from '../config'
import { RESERVED_GROUPS } from '../authorization'

/**
 * Options for creating a mock BranchContext
 */
export interface MockBranchContextOptions {
  branchName?: string
  status?: BranchStatus
  createdBy?: string
  access?: BranchAccessControl
  baseRoot?: string
  branchRoot?: string
  pullRequestNumber?: number
  pullRequestUrl?: string
  title?: string
  description?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Create a mock BranchContext with sensible defaults.
 *
 * @param options - Override any default values
 * @returns A complete BranchContext object for testing
 *
 * @example
 * // Default: main branch in editing status
 * const ctx = createMockBranchContext()
 *
 * @example
 * // Custom branch with PR info
 * const ctx = createMockBranchContext({
 *   branchName: 'feature/test',
 *   status: 'submitted',
 *   pullRequestNumber: 123
 * })
 */
export function createMockBranchContext(options: MockBranchContextOptions = {}): BranchContext {
  const branchName = options.branchName ?? 'main'
  const baseRoot = options.baseRoot ?? '/tmp/base'
  const branchRoot =
    options.branchRoot ?? (branchName === 'main' ? baseRoot : `${baseRoot}/${branchName}`)

  return {
    baseRoot,
    branchRoot,
    branch: {
      name: branchName,
      status: options.status ?? 'editing',
      access: options.access ?? {},
      createdBy: options.createdBy ?? 'u1',
      createdAt: options.createdAt ?? 'now',
      updatedAt: options.updatedAt ?? 'now',
      ...(options.title && { title: options.title }),
      ...(options.description && { description: options.description }),
      ...(options.pullRequestNumber && {
        pullRequestNumber: options.pullRequestNumber,
      }),
      ...(options.pullRequestUrl && { pullRequestUrl: options.pullRequestUrl }),
    },
  }
}

/**
 * Options for creating a mock user
 */
export interface MockUserOptions {
  userId?: string
  groups?: string[]
}

/**
 * Create a mock CanopyUser with common role presets.
 *
 * @param role - User role preset: 'admin', 'reviewer', or 'user'
 * @param options - Override userId or groups
 * @returns A CanopyUser object for testing
 *
 * @example
 * const admin = createMockUser('admin')
 * const reviewer = createMockUser('reviewer')
 * const user = createMockUser() // default is regular user
 * const custom = createMockUser('user', { userId: 'custom-user', groups: ['editors'] })
 */
export function createMockUser(
  role: 'admin' | 'reviewer' | 'user' = 'user',
  options: MockUserOptions = {},
): CanopyUser {
  const defaults = {
    admin: { userId: 'admin', groups: [RESERVED_GROUPS.ADMINS] },
    reviewer: { userId: 'reviewer', groups: [RESERVED_GROUPS.REVIEWERS] },
    user: { userId: 'u1', groups: [] },
  }

  const preset = defaults[role]

  return {
    type: 'authenticated',
    userId: options.userId ?? preset.userId,
    groups: options.groups ?? preset.groups,
  }
}

/**
 * Create a mock GitManager with all required methods.
 *
 * @returns A mock GitManager object with vi.fn() for all methods
 *
 * @example
 * const gitManager = createMockGitManager()
 * gitManager.status.mockResolvedValue({ files: [], ahead: 0, behind: 0, current: 'main' })
 */
export function createMockGitManager() {
  return {
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({
      files: [],
      ahead: 0,
      behind: 0,
      current: 'main',
    }),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    ensureAuthor: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Options for creating mock CanopyServices
 */
export interface MockServicesOptions {
  config?: Partial<CanopyConfig>
  entrySchemaRegistry?: any
  branchSchemaCache?: any
  checkBranchAccess?: any
  checkPathAccess?: any
  checkContentAccess?: any
  createGitManagerFor?: any
  registry?: any
  githubService?: any
  bootstrapAdminIds?: Set<string>
  commitFiles?: any
  submitBranch?: any
  commitToSettingsBranch?: any
  getSettingsBranchRoot?: any
}

/**
 * Create mock CanopyServices with sensible defaults.
 *
 * @param options - Override any service properties
 * @returns A complete CanopyServices object for testing
 *
 * @example
 * const services = createMockServices({
 *   config: { mode: 'dev' }
 * })
 */
export function createMockServices(options: MockServicesOptions = {}): CanopyServices {
  const defaultConfig: Partial<CanopyConfig> = {
    defaultBaseBranch: 'main',
    mode: 'dev',
    ...options.config,
  }

  return {
    config: defaultConfig as any,
    entrySchemaRegistry: options.entrySchemaRegistry ?? {},
    branchSchemaCache:
      options.branchSchemaCache ??
      ({
        getSchema: vi.fn().mockResolvedValue({
          schema: {},
          flatSchema: [],
        }),
        invalidate: vi.fn().mockResolvedValue(undefined),
        clearAll: vi.fn().mockResolvedValue(undefined),
      } as any),
    checkBranchAccess:
      options.checkBranchAccess ?? vi.fn().mockReturnValue({ allowed: true, reason: 'allowed' }),
    checkPathAccess: options.checkPathAccess ?? (undefined as any),
    checkContentAccess:
      options.checkContentAccess ??
      vi.fn().mockResolvedValue({ allowed: true, branch: {}, path: {} }),
    createGitManagerFor: options.createGitManagerFor ?? vi.fn(() => createMockGitManager()),
    registry: options.registry ?? (undefined as any),
    githubService: options.githubService,
    bootstrapAdminIds: options.bootstrapAdminIds ?? new Set<string>(),
    commitFiles: options.commitFiles ?? vi.fn().mockResolvedValue(undefined),
    submitBranch: options.submitBranch ?? vi.fn().mockResolvedValue(undefined),
    commitToSettingsBranch:
      options.commitToSettingsBranch ??
      vi.fn().mockResolvedValue({ committed: true, pushed: true }),
    getSettingsBranchRoot:
      options.getSettingsBranchRoot ?? vi.fn().mockResolvedValue('/mock/settings'),
  }
}

/**
 * Options for creating mock ApiContext
 */
export interface MockApiContextOptions {
  services?: Partial<CanopyServices>
  getBranchContext?: any
  assetStore?: any
  authPlugin?: any
  // Convenience options
  branchContext?: BranchContext | null
  allowBranchAccess?: boolean
  allowContentAccess?: boolean
}

/**
 * Create a mock ApiContext with sensible defaults.
 *
 * @param options - Override any context properties
 * @returns A complete ApiContext object for testing
 *
 * @example
 * // Simple context with default main branch
 * const ctx = createMockApiContext()
 *
 * @example
 * // Context with custom branch and access control
 * const ctx = createMockApiContext({
 *   branchContext: createMockBranchContext({ branchName: 'feature/test' }),
 *   allowBranchAccess: false
 * })
 *
 * @example
 * // Context with branch not found
 * const ctx = createMockApiContext({ branchContext: null })
 */
export function createMockApiContext(options: MockApiContextOptions = {}): ApiContext {
  // Handle convenience options for access control
  const servicesOptions: MockServicesOptions = {}

  if (options.allowBranchAccess !== undefined) {
    servicesOptions.checkBranchAccess = vi.fn().mockReturnValue({
      allowed: options.allowBranchAccess,
      reason: options.allowBranchAccess ? 'allowed' : 'denied',
    })
  }

  if (options.allowContentAccess !== undefined) {
    servicesOptions.checkContentAccess = vi.fn().mockResolvedValue({
      allowed: options.allowContentAccess,
      branch: {},
      path: {},
    })
  }

  // Merge with user-provided services
  const services = createMockServices({
    ...servicesOptions,
    ...options.services,
  })

  // Handle branchContext convenience option
  let getBranchContext = options.getBranchContext
  if (options.branchContext !== undefined && !options.getBranchContext) {
    getBranchContext = vi.fn().mockResolvedValue(options.branchContext)
  }

  return {
    services,
    getBranchContext: getBranchContext ?? vi.fn().mockResolvedValue(createMockBranchContext()),
    ...(options.assetStore && { assetStore: options.assetStore }),
    ...(options.authPlugin && { authPlugin: options.authPlugin }),
  }
}

/**
 * Create a mock BranchRegistry with default branches.
 *
 * @param branches - Optional array of branch contexts to include
 * @returns A mock registry with list, get, and invalidate methods
 *
 * @example
 * const registry = createMockRegistry()
 *
 * @example
 * const registry = createMockRegistry([
 *   createMockBranchContext({ branchName: 'feature/a', createdBy: 'u1' }),
 *   createMockBranchContext({ branchName: 'feature/b', createdBy: 'u2' })
 * ])
 */
export function createMockRegistry(branches?: BranchContext[]) {
  const defaultBranches = branches ?? [
    createMockBranchContext({ branchName: 'feature/a', createdBy: 'u1' }),
    createMockBranchContext({ branchName: 'feature/b', createdBy: 'u2' }),
    createMockBranchContext({
      branchName: 'feature/c',
      createdBy: 'u3',
      access: { allowedUsers: ['u1'] },
    }),
    createMockBranchContext({
      branchName: 'feature/d',
      createdBy: 'u3',
      access: { allowedGroups: ['editors'] },
    }),
  ]

  return {
    list: vi.fn().mockResolvedValue(defaultBranches),
    get: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Create a mock GitHub service.
 *
 * @returns A mock GitHub service with common methods
 *
 * @example
 * const githubService = createMockGitHubService()
 * githubService.convertToDraft.mockResolvedValue(undefined)
 */
export function createMockGitHubService() {
  return {
    convertToDraft: vi.fn().mockResolvedValue(undefined),
    markReadyForReview: vi.fn().mockResolvedValue(undefined),
    closePullRequest: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Create a mock BranchMetadataFileManager for use with vi.mock().
 *
 * @param saveImpl - Optional custom implementation for save method
 * @returns Mock implementation object
 *
 * @example
 * vi.mock('../branch-metadata', () => createMockBranchMetadata())
 *
 * @example
 * const mockSave = vi.fn().mockResolvedValue({ branch: { status: 'submitted' } })
 * vi.mock('../branch-metadata', () => createMockBranchMetadata(mockSave))
 */
export function createMockBranchMetadata(saveImpl?: any) {
  const defaultSave = vi.fn().mockResolvedValue({
    schemaVersion: 1,
    branch: {
      name: 'feature/x',
      status: 'editing',
      access: {},
      createdBy: 'u1',
      createdAt: 'now',
      updatedAt: 'now',
    },
  })

  const save = saveImpl ?? defaultSave

  return {
    BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
      save,
    })),
    getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
      save,
    })),
  }
}

/**
 * Create mock permissions loader for use with vi.mock().
 *
 * @param permissions - Default permissions to return
 * @returns Mock implementation object
 *
 * @example
 * vi.mock('../permissions-loader', () => createMockPermissionsLoader())
 *
 * @example
 * vi.mock('../permissions-loader', () =>
 *   createMockPermissionsLoader([{ path: 'content/**', edit: { allowedUsers: ['u1'] } }])
 * )
 */
export function createMockPermissionsLoader(permissions: PathPermission[] = []) {
  return {
    loadPathPermissions: vi.fn().mockResolvedValue(permissions),
    loadPermissionsFile: vi.fn().mockResolvedValue(null),
    savePathPermissions: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Create mock BranchWorkspaceManager for use with vi.mock().
 *
 * @param branchContext - Optional branch context to return from openOrCreateBranch
 * @returns Mock implementation object
 *
 * @example
 * vi.mock('../branch-workspace', () => createMockBranchWorkspace())
 */
export function createMockBranchWorkspace(branchContext?: BranchContext) {
  const defaultContext =
    branchContext ??
    createMockBranchContext({
      branchName: 'feature/test',
    })

  return {
    BranchWorkspaceManager: vi.fn().mockImplementation(() => ({
      openOrCreateBranch: vi.fn().mockResolvedValue(defaultContext),
    })),
  }
}

/**
 * Create mock CommentStore for use with vi.mock().
 *
 * @returns Mock implementation object
 *
 * @example
 * vi.mock('../comment-store', () => createMockCommentStore())
 */
export function createMockCommentStore() {
  return {
    CommentStore: vi.fn().mockImplementation(() => ({
      listThreads: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue({ threadId: 'thread1', commentId: 'c1' }),
      getThread: vi.fn().mockResolvedValue({
        id: 'thread1',
        comments: [],
        resolved: false,
        type: 'field',
        entryPath: 'posts/hello',
        canopyPath: 'title',
        authorId: 'u1',
        createdAt: 'now',
      }),
      resolveThread: vi.fn().mockResolvedValue(true),
    })),
  }
}
