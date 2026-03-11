/**
 * Integration tests for path-based permissions.
 * Tests glob pattern matching, first-match-wins rule, and permission levels.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createTestWorkspace, type TestWorkspace } from '../test-utils/test-workspace'
import { createTestUser } from '../test-utils/multi-user'
import { BLOG_SCHEMA } from '../fixtures/schemas'
import { BranchWorkspaceManager } from '../../branch-workspace'
import {
  checkBranchAccessWithDefault,
  loadPathPermissions,
  savePathPermissions,
  createCheckPathAccess,
  toPermissionPath,
} from '../../authorization'
import { toPhysicalPath } from '../../paths'

describe('Path Permission Integration', () => {
  let workspace: TestWorkspace

  beforeEach(async () => {
    workspace = await createTestWorkspace({
      schema: BLOG_SCHEMA,
      defaultPathAccess: 'allow',
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('restricts editor from editing posts/** when not in allowed group', async () => {
    const editor = createTestUser('editor')
    const manager = new BranchWorkspaceManager(workspace.config)

    const branch = await manager.openOrCreateBranch({
      branchName: 'test-permissions',
      mode: 'prod-sim',
      title: 'Permission Test',
      createdBy: editor.userId,
      remoteUrl: workspace.remotePath,
    })

    // Set up path permissions: only 'BlogAuthors' group can edit posts
    await savePathPermissions(
      branch.branchRoot,
      [
        {
          path: toPermissionPath('content/posts/**'),
          edit: { allowedGroups: ['BlogAuthors'] },
        },
      ],
      'test-admin',
      'prod-sim'
    )

    // Load permissions and check access
    const rules = await loadPathPermissions(branch.branchRoot, 'prod-sim')
    const pathChecker = createCheckPathAccess(rules, workspace.config.defaultPathAccess ?? 'deny')

    const access = pathChecker({
      relativePath: toPhysicalPath('content/posts/hello.mdx'),
      user: editor,
      level: 'edit',
    })

    expect(access.allowed).toBe(false)
    expect(access.reason).toBe('denied_by_rule')
  })

  it('allows admin to bypass path permissions', async () => {
    const admin = createTestUser('admin')
    const manager = new BranchWorkspaceManager(workspace.config)

    const branch = await manager.openOrCreateBranch({
      branchName: 'test-admin-bypass',
      mode: 'prod-sim',
      title: 'Admin Bypass Test',
      createdBy: admin.userId,
      remoteUrl: workspace.remotePath,
    })

    // Check branch access first - admin should have bypass
    const branchAccess = checkBranchAccessWithDefault(branch, admin)
    expect(branchAccess.allowed).toBe(true)
    expect(branchAccess.reason).toBe('privileged')

    // Set up strict path permissions
    await savePathPermissions(
      branch.branchRoot,
      [
        {
          path: toPermissionPath('content/posts/**'),
          edit: { allowedGroups: ['BlogAuthors'] },
        },
      ],
      admin.userId,
      'prod-sim'
    )

    // Admin bypasses at branch level, so path restrictions don't matter
    const rules = await loadPathPermissions(branch.branchRoot, 'prod-sim')
    const pathChecker = createCheckPathAccess(rules, workspace.config.defaultPathAccess ?? 'deny')

    // Path check alone would fail for non-BlogAuthors
    const pathAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/restricted.mdx'),
      user: admin,
      level: 'edit',
    })

    // Admin has bypass via groups (Admins group), but path check would deny
    expect(admin.groups).toContain('Admins')
    // Path access would be denied for non-BlogAuthors, but admin bypasses at branch level
    expect(pathAccess.allowed).toBe(true) // Path rule denies, but admin bypasses elsewhere
  })

  it('applies first-match-wins rule for glob patterns', async () => {
    const editor = createTestUser('editor')
    const manager = new BranchWorkspaceManager(workspace.config)

    const branch = await manager.openOrCreateBranch({
      branchName: 'test-glob-matching',
      mode: 'prod-sim',
      title: 'Glob Pattern Test',
      createdBy: editor.userId,
      remoteUrl: workspace.remotePath,
    })

    // Set up overlapping permissions - first match wins
    await savePathPermissions(
      branch.branchRoot,
      [
        {
          path: toPermissionPath('content/posts/public-*'),
          edit: { allowedGroups: ['ContentEditors'] }, // Allow ContentEditors to edit public posts
        },
        {
          path: toPermissionPath('content/posts/**'),
          edit: { allowedGroups: ['BlogAuthors'] }, // Restrict all other posts to BlogAuthors
        },
      ],
      'test-admin',
      'prod-sim'
    )

    const rules = await loadPathPermissions(branch.branchRoot, 'prod-sim')
    const pathChecker = createCheckPathAccess(rules, workspace.config.defaultPathAccess ?? 'deny')

    // Check access to public post (should match first rule)
    const publicAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/public-announcement.mdx'),
      user: editor,
      level: 'edit',
    })

    expect(publicAccess.allowed).toBe(true)

    // Check access to private post (should match second rule and be denied)
    const privateAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/private-draft.mdx'),
      user: editor,
      level: 'edit',
    })

    expect(privateAccess.allowed).toBe(false)
  })

  it('supports different permission levels: read, edit, review', async () => {
    const reviewer = createTestUser('reviewer')
    const editor = createTestUser('editor')
    const manager = new BranchWorkspaceManager(workspace.config)

    const branch = await manager.openOrCreateBranch({
      branchName: 'test-permission-levels',
      mode: 'prod-sim',
      title: 'Permission Levels Test',
      createdBy: editor.userId,
      remoteUrl: workspace.remotePath,
    })

    // Set up multi-level permissions
    await savePathPermissions(
      branch.branchRoot,
      [
        {
          path: toPermissionPath('content/posts/**'),
          // No read restriction (defaults to allow if defaultPathAccess is 'allow')
          edit: { allowedGroups: ['ContentEditors'] }, // Only editors can edit
          review: { allowedGroups: ['Reviewers', 'Admins'] }, // Only reviewers can review
        },
      ],
      'test-admin',
      'prod-sim'
    )

    const rules = await loadPathPermissions(branch.branchRoot, 'prod-sim')
    const pathChecker = createCheckPathAccess(rules, workspace.config.defaultPathAccess ?? 'deny')

    // Reviewer can read and review, but not edit
    const reviewerReadAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/test.mdx'),
      user: reviewer,
      level: 'read',
    })
    expect(reviewerReadAccess.allowed).toBe(true)

    const reviewerReviewAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/test.mdx'),
      user: reviewer,
      level: 'review',
    })
    expect(reviewerReviewAccess.allowed).toBe(true)

    const reviewerEditAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/test.mdx'),
      user: reviewer,
      level: 'edit',
    })
    expect(reviewerEditAccess.allowed).toBe(false)

    // Editor can read and edit, but not review
    const editorReadAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/test.mdx'),
      user: editor,
      level: 'read',
    })
    expect(editorReadAccess.allowed).toBe(true)

    const editorEditAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/test.mdx'),
      user: editor,
      level: 'edit',
    })
    expect(editorEditAccess.allowed).toBe(true)

    const editorReviewAccess = pathChecker({
      relativePath: toPhysicalPath('content/posts/test.mdx'),
      user: editor,
      level: 'review',
    })
    expect(editorReviewAccess.allowed).toBe(false)
  })

  it('allows entry access with specific path rules', async () => {
    const editor = createTestUser('editor')
    const manager = new BranchWorkspaceManager(workspace.config)

    const branch = await manager.openOrCreateBranch({
      branchName: 'test-entry-perms',
      mode: 'prod-sim',
      title: 'Entry Permission Test',
      createdBy: editor.userId,
      remoteUrl: workspace.remotePath,
    })

    // Allow editing about page for ContentEditors
    await savePathPermissions(
      branch.branchRoot,
      [
        {
          path: toPermissionPath('content/about.md'),
          edit: { allowedGroups: ['ContentEditors'] },
        },
      ],
      'test-admin',
      'prod-sim'
    )

    const rules = await loadPathPermissions(branch.branchRoot, 'prod-sim')
    const pathChecker = createCheckPathAccess(rules, workspace.config.defaultPathAccess ?? 'deny')

    // Editor should have access to about page
    const access = pathChecker({
      relativePath: toPhysicalPath('content/about.md'),
      user: editor,
      level: 'edit',
    })

    expect(access.allowed).toBe(true)
  })

  it('persists permission rules across branch lifecycle', async () => {
    const admin = createTestUser('admin')
    const manager = new BranchWorkspaceManager(workspace.config)

    const branch = await manager.openOrCreateBranch({
      branchName: 'test-persist-perms',
      mode: 'prod-sim',
      title: 'Permission Persistence Test',
      createdBy: admin.userId,
      remoteUrl: workspace.remotePath,
    })

    // Set up permissions
    const initialRules: any[] = [
      {
        path: toPermissionPath('content/posts/**'),
        edit: { allowedGroups: ['BlogAuthors'] },
      },
    ]

    await savePathPermissions(branch.branchRoot, initialRules, admin.userId, 'prod-sim')

    // Load and verify
    const loadedRules = await loadPathPermissions(branch.branchRoot, 'prod-sim')
    expect(loadedRules).toHaveLength(1)
    expect(loadedRules[0].path).toBe('content/posts/**')
    expect(loadedRules[0].edit?.allowedGroups).toContain('BlogAuthors')
  })
})
