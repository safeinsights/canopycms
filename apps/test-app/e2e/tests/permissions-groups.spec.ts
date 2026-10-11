import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'
import {
  GroupManagerPage,
  PermissionManagerPage,
  clearPermissionsViaApi,
  removeE2eGroupsViaApi,
} from '../fixtures/settings-managers-page'

/**
 * E2E tests for the Group Manager and Permission Manager (Settings gear ->
 * "Manage Groups" / "Manage Permissions"): admin gating (D3), group CRUD
 * round trip (D1), and path-permission assignment round trip (D2).
 *
 * Selector strategy is documented in `../fixtures/settings-managers-page.ts`.
 */
test.describe('Permissions and Groups', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('D3: admin surfaces are offered to an admin only; the underlying APIs 403 for a non-admin', async ({
    page,
  }) => {
    const groupManager = new GroupManagerPage(page)
    const permissionManager = new PermissionManagerPage(page)

    await test.step('open editor as admin', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('as admin: both menu items are present and open their drawers', async () => {
      await editorPage.openSettingsMenu()
      await expect(editorPage.settingsMenuItem('Permissions')).toBeVisible()
      await expect(editorPage.settingsMenuItem('Groups')).toBeVisible()

      await editorPage.settingsMenuItem('Permissions').click()
      const permissionsDrawer = permissionManager.drawer
      await expect(permissionsDrawer).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(permissionsDrawer.getByRole('button', { name: 'Expand All' })).toBeVisible()
      await permissionManager.close()

      await groupManager.open()
      const groupsDrawer = groupManager.drawer
      await expect(groupsDrawer.getByRole('tab', { name: 'Internal Groups' })).toBeVisible()
      await groupManager.close()
    })

    await test.step('as editor: no admin menu items, and no collection admin actions', async () => {
      await switchUser(page, 'editor')
      await page.reload()
      await editorPage.waitForReady()

      await editorPage.openSettingsMenu()
      await expect(editorPage.settingsMenuItem('Media library')).toBeVisible()
      await expect(editorPage.settingsMenuItem('Permissions')).toHaveCount(0)
      await expect(editorPage.settingsMenuItem('Groups')).toHaveCount(0)
      await expect(editorPage.settingsMenuItem('System health')).toHaveCount(0)
      await page.keyboard.press('Escape')

      await editorPage.openContentNavigator()
      const items = await editorPage.collectionMenuItems('Posts')
      await expect(items.filter({ hasText: 'Add Entry' })).toHaveCount(1)
      for (const adminOnly of ['Add Sub-Collection', 'Edit Collection', 'Delete Collection']) {
        await expect(items.filter({ hasText: adminOnly })).toHaveCount(0)
      }
      await page.keyboard.press('Escape')
    })

    await test.step('API contract: GET /permissions and GET /groups/internal both 403 for a non-admin', async () => {
      const permsRes = await page.request.get('/api/canopycms/permissions', {
        headers: { 'X-Test-User': 'editor' },
      })
      expect(permsRes.status()).toBe(403)

      const groupsRes = await page.request.get('/api/canopycms/groups/internal', {
        headers: { 'X-Test-User': 'editor' },
      })
      expect(groupsRes.status()).toBe(403)
    })
  })

  test('D1: group manager round trip — create an internal group, save, and verify persistence', async ({
    page,
  }) => {
    const groupName = `e2e-group-${Date.now()}`
    const description = 'Created by permissions-groups.spec.ts (D1)'
    const groupManager = new GroupManagerPage(page)

    // Groups live in the settings workspace that resetWorkspace() never
    // touches, so without cleanup every run of this test adds one more group
    // to groups.json, forever. Heal prior runs' leftovers up front (including
    // crashed runs that never reached the finally), then remove this run's
    // group on the way out.
    await test.step('self-heal: remove e2e groups left by prior runs', () =>
      removeE2eGroupsViaApi(page))

    try {
      await test.step('open editor and Manage Groups', async () => {
        await editorPage.goto()
        await editorPage.waitForReady()
        await groupManager.open()
      })

      await test.step('create a new internal group', async () => {
        await groupManager.createGroup(groupName, description)
        await expect(groupManager.groupEntry(groupName)).toBeVisible()
      })

      await test.step('save groups and wait for the PUT to resolve (commits + pushes through the settings lock)', async () => {
        await expect(groupManager.saveButton).toBeVisible({ timeout: SHORT_TIMEOUT })
        await groupManager.saveAndVerify()
        // isDirty resets on a successful save, so the footer disappears.
        await expect(groupManager.saveButton).toBeHidden({ timeout: STANDARD_TIMEOUT })
      })

      await test.step('verify persistence: reload, reopen the drawer, group still listed', async () => {
        await groupManager.close()
        await page.reload()
        await editorPage.waitForReady()
        await groupManager.open()
        await expect(groupManager.groupEntry(groupName)).toBeVisible({ timeout: STANDARD_TIMEOUT })
      })

      await test.step('verify persistence server-side via GET /api/canopycms/groups/internal', async () => {
        const res = await page.request.get('/api/canopycms/groups/internal', {
          headers: { 'X-Test-User': 'admin' },
        })
        expect(res.status()).toBe(200)
        const body = (await res.json()) as { data: { groups: Array<{ name: string }> } }
        expect(body.data.groups.map((g) => g.name)).toContain(groupName)
      })
    } finally {
      // Best-effort: if the test failed because the page/server died, this
      // page.request-based cleanup fails too -- swallowing it keeps the
      // PRIMARY assertion error as the reported failure (a finally that
      // throws replaces it). The start-of-test self-heal covers the state.
      await test.step('cleanup: remove the created group (settings workspace is never reset)', () =>
        removeE2eGroupsViaApi(page).catch((err) =>
          console.warn('e2e group cleanup failed (state self-heals next run):', err),
        ))
    }
  })

  test('D2: permission manager round trip — assign a group at a level, save, and verify persistence', async ({
    page,
  }) => {
    const permissionManager = new PermissionManagerPage(page)

    // Permissions live in a settings workspace that resetWorkspace() never
    // touches (see clearPermissionsViaApi's doc comment), so a prior run's
    // "Team A" assignment on Posts/Edit would make this test's "assign" step
    // a silent no-op. Start from a known-clean slate.
    await test.step('clear existing permissions for a deterministic starting point', async () => {
      await clearPermissionsViaApi(page)
    })

    try {
      await test.step('open editor and Manage Permissions', async () => {
        await editorPage.goto()
        await editorPage.waitForReady()
        await permissionManager.open()
      })

      // The tree only surfaces actual sub-COLLECTIONS as nodes
      // (convertCollectionsToTreeNodes walks `collection.children`, never
      // `collection.entryTypes`) — so "Home"/"Settings" (single-instance entry
      // types defined directly on the root collection) never appear as
      // separate nodes; only "content" (root) and "Posts" (the one real child
      // collection) do. See this test file's final report for the full note.
      await test.step('select the Posts content node and assign "Team A" at Edit level', async () => {
        await permissionManager.selectNode('Posts')
        await permissionManager.assignGroup('Team A', 'Edit')
        await expect(permissionManager.drawer.getByText('Team A', { exact: true })).toBeVisible()
      })

      await test.step('save permissions and wait for the PUT to resolve (commits + pushes through the settings lock)', async () => {
        await expect(permissionManager.saveButton).toBeVisible({ timeout: SHORT_TIMEOUT })
        await permissionManager.saveAndVerify()
        await expect(permissionManager.saveButton).toBeHidden({ timeout: STANDARD_TIMEOUT })
      })

      await test.step('verify persistence: reload, reopen, reselect Posts/Edit, badge still present', async () => {
        await permissionManager.close()
        await page.reload()
        await editorPage.waitForReady()
        await permissionManager.open()
        await permissionManager.selectNode('Posts')
        await permissionManager.levelTab('Edit').click()
        await expect(permissionManager.drawer.getByText('Team A', { exact: true })).toBeVisible({
          timeout: STANDARD_TIMEOUT,
        })
      })

      await test.step('verify persistence server-side via GET /api/canopycms/permissions', async () => {
        const res = await page.request.get('/api/canopycms/permissions', {
          headers: { 'X-Test-User': 'admin' },
        })
        expect(res.status()).toBe(200)
        const body = (await res.json()) as {
          data: { permissions: Array<{ path: string; edit?: { allowedGroups?: string[] } }> }
        }
        const match = body.data.permissions.find((p) => p.edit?.allowedGroups?.includes('team-a'))
        expect(match).toBeTruthy()
        expect(match?.path.toLowerCase()).toContain('posts')
      })
    } finally {
      // The assigned rule would otherwise persist in the settings workspace
      // forever (resetWorkspace never touches it) — a latent deny for any
      // future non-admin spec that edits Posts. The start-of-test clear
      // handles crashed prior runs; this handles the happy path. Best-effort
      // (.catch) so a dead page/server doesn't replace the primary failure.
      await test.step('cleanup: clear permissions again (settings workspace is never reset)', () =>
        clearPermissionsViaApi(page).catch((err) =>
          console.warn('permissions cleanup failed (state self-heals next run):', err),
        ))
    }
  })
})
