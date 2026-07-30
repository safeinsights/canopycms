import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'
import {
  GroupManagerPage,
  PermissionManagerPage,
  clearPermissionsViaApi,
} from '../fixtures/settings-managers-page'

const BASE_URL = 'http://localhost:5174'

/**
 * E2E tests for the Group Manager and Permission Manager (Settings gear ->
 * "Manage Groups" / "Manage Permissions"): admin gating (D3), group CRUD
 * round trip (D1), and path-permission assignment round trip (D2).
 *
 * Selector strategy is documented in `../fixtures/settings-managers-page.ts`
 * — neither module carries `data-testid`s, so every locator here is
 * role/text based and was confirmed against the component source.
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

  test('D3: Settings menu items open their drawers for an admin; the underlying APIs 403 for a non-admin', async ({
    page,
  }) => {
    await test.step('open editor as admin', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('as admin: both menu items are present and open their drawers', async () => {
      await page.getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByRole('menuitem', { name: 'Manage Permissions' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Manage Groups' })).toBeVisible()

      await page.getByRole('menuitem', { name: 'Manage Permissions' }).click()
      const permissionsDrawer = page.getByRole('dialog', { name: 'Permissions' })
      await expect(permissionsDrawer).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(permissionsDrawer.getByRole('button', { name: 'Expand All' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(permissionsDrawer).toBeHidden({ timeout: SHORT_TIMEOUT })

      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('menuitem', { name: 'Manage Groups' }).click()
      const groupsDrawer = page.getByRole('dialog', { name: 'Groups' })
      await expect(groupsDrawer).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(groupsDrawer.getByRole('tab', { name: 'Internal Groups' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(groupsDrawer).toBeHidden({ timeout: SHORT_TIMEOUT })
    })

    // NOTE (checked against source, not assumed): unlike "System health" —
    // whose menu item Editor.tsx renders only when `isAdmin(userContext?.groups)`
    // is true (`onSystemHealthOpen={showSystemHealth ? ... : undefined}`) —
    // EditorSidebar's `onPermissionManagerOpen`/`onGroupManagerOpen` are wired
    // unconditionally (Editor.tsx), and both managers are instantiated with
    // `canEdit={true}` hardcoded rather than derived from the viewer's role.
    // So for a non-admin the menu items stay visible and the drawers open;
    // what actually protects the data is the server-side `guards: ['admin']`
    // on the GET/PUT routes, which the client-side load surfaces only as a
    // generic "Failed to load..." notification, not an access-denied message.
    await test.step('as editor: menu items are still rendered and drawers still open (no client-side admin gate)', async () => {
      await switchUser(page, 'editor')
      await page.reload()
      await editorPage.waitForReady()

      await page.getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByRole('menuitem', { name: 'Manage Permissions' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Manage Groups' })).toBeVisible()

      await page.getByRole('menuitem', { name: 'Manage Permissions' }).click()
      const permissionsDrawer = page.getByRole('dialog', { name: 'Permissions' })
      await expect(permissionsDrawer).toBeVisible({ timeout: STANDARD_TIMEOUT })
      // The drawer opens, but the load silently fails behind the scenes —
      // this is the "truthful" behavior: no access-denied messaging, just a
      // generic load failure (usePermissionManager.ts).
      await expect(
        page.locator('.mantine-Notification-root', { hasText: 'Failed to load permissions' }),
      ).toBeVisible({ timeout: STANDARD_TIMEOUT })
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
  })
})
