import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type BrowserContext } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch, readContentFile } from '../fixtures/test-workspace'

/**
 * The editor's signed-out paths, through the real dev auth plugin.
 *
 * These specs authenticate by COOKIE, never with the `X-Test-User` header the
 * other specs use: dev auth lets a header win over the cookie, so a header
 * would mask exactly the signed-out state under test.
 */
const DEV_USER_COOKIE = 'canopy-dev-user'
// DEV_SIGNED_OUT in canopycms-auth-dev/src/cookie-utils.ts.
const SIGNED_OUT = '__canopy_signed_out__'
// DEV_ADMIN_USER_ID in canopycms-auth-dev/src/dev-defaults.ts.
const ADMIN = 'dev_admin_3xY6zW1qR5'

const setDevUser = (context: BrowserContext, value: string) =>
  context.addCookies([{ name: DEV_USER_COOKIE, value, url: BASE_URL }])

test.describe('Signed-out users (dev auth)', () => {
  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
  })

  test('a signed-out visitor gets the sign-in screen, and signing in mounts the editor', async ({
    page,
    context,
  }) => {
    await setDevUser(context, SIGNED_OUT)
    const editorPage = new EditorPage(page)
    await editorPage.goto()

    await expect(page.getByTestId('canopy-sign-in-screen')).toBeVisible()
    await expect(editorPage.formPane).toHaveCount(0)

    await page.getByTestId(`dev-user-${ADMIN}`).click()

    await editorPage.waitForReady()
    await expect(page.getByTestId('canopy-sign-in-screen')).toHaveCount(0)
  })

  test('signing out from the user switcher lands on the sign-in screen', async ({
    page,
    context,
  }) => {
    await setDevUser(context, ADMIN)
    const editorPage = new EditorPage(page)
    await editorPage.goto()
    await editorPage.waitForReady()

    await page.getByRole('button', { name: 'Switch user' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page.getByTestId('canopy-sign-in-screen')).toBeVisible()
  })

  test('a session that ends mid-edit overlays sign-in and keeps the unsaved edit', async ({
    page,
    context,
  }) => {
    await setDevUser(context, ADMIN)
    const editorPage = new EditorPage(page)
    await editorPage.goto()
    await editorPage.waitForReady()
    await editorPage.openEntryNavigator()
    await editorPage.selectEntry('Home Page')

    const unsaved = `Lapsed-${Date.now()}`
    await editorPage.fillTextField('title', unsaved)

    // The session ends while the editor is open (e.g. signed out in another tab).
    await setDevUser(context, SIGNED_OUT)
    await editorPage.save()

    const overlay = page.getByTestId('canopy-sign-in-overlay')
    await expect(overlay).toBeVisible()
    await overlay.getByTestId(`dev-user-${ADMIN}`).click()
    await expect(overlay).toHaveCount(0)

    // Same identity, so the editor was never remounted: the edit is still there to save.
    await expect(editorPage.getFieldInput('title')).toHaveValue(unsaved)
    await editorPage.saveAndVerify()
    const content = await readContentFile<{ title: string }>('home.home.bo7QdSwn9Tod.json')
    expect(content.title).toBe(unsaved)
  })
})
