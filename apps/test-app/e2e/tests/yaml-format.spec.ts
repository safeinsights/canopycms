import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import {
  resetWorkspace,
  ensureMainBranch,
  readRawContentFile,
  findContentFile,
} from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT } from '../fixtures/timeouts'

// The settings YAML file is seeded from content/ into the main branch workspace.
const SETTINGS_CONTENT_PATH = 'settings.settings.sEtTiNgS5678.yaml'

/**
 * E2E tests for YAML content format support, and for how entries are named in the navigator.
 *
 * The settings entry type uses YAML format and has isTitle: true on siteName, but it is a
 * single-entry type, so the navigator names it by its type label. A post is named by its title.
 */
test.describe('YAML format and entry names', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('YAML entry loads and displays field values correctly', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open entry navigator and select Settings entry', async () => {
      await editorPage.openContentNavigator()
      // A single-entry type is named by its type label, "Settings", not its siteName title
      await editorPage.selectEntry('Settings')
      await editorPage.closeContentNavigator()
    })

    await test.step('verify siteName field shows the seeded value', async () => {
      await editorPage.verifyFieldValue('siteName', 'Test Site')
    })

    await test.step('verify maintenanceMode toggle is unchecked', async () => {
      const toggle = page.locator('[data-testid="field-toggle-maintenanceMode"]')
      await expect(toggle).toBeVisible({ timeout: STANDARD_TIMEOUT })
      const checkbox = toggle.locator('input[type="checkbox"]')
      await expect(checkbox).not.toBeChecked()
    })
  })

  test('edit and save YAML entry writes valid YAML to disk', async ({ page }) => {
    const newSiteName = `My Updated Site ${Date.now()}`

    await test.step('open editor and navigate to Settings', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Settings')
      await editorPage.closeContentNavigator()
    })

    await test.step('edit siteName and toggle maintenanceMode on', async () => {
      await editorPage.fillTextField('siteName', newSiteName)

      // Click the toggle wrapper (Mantine Switch hides the actual checkbox input)
      const toggle = page.locator('[data-testid="field-toggle-maintenanceMode"]')
      await toggle.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })
      await toggle.click()
      await expect(toggle.locator('input[type="checkbox"]')).toBeChecked()
    })

    await test.step('save', async () => {
      await editorPage.saveAndVerify()
    })

    await test.step('verify disk file is YAML (not JSON)', async () => {
      const raw = await readRawContentFile(SETTINGS_CONTENT_PATH)

      // A YAML file should NOT start with '{' (which would indicate JSON)
      expect(raw.trim()).not.toMatch(/^\{/)

      // Should contain the siteName value as YAML
      expect(raw).toContain(newSiteName)

      // maintenanceMode: true in YAML
      expect(raw).toContain('maintenanceMode: true')
    })
  })

  test('YAML entry persists after page reload', async ({ page }) => {
    const uniqueSiteName = `Reload Test Site ${Date.now()}`

    await test.step('edit and save', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Settings')
      await editorPage.closeContentNavigator()

      await editorPage.fillTextField('siteName', uniqueSiteName)
      await editorPage.saveAndVerify()
    })

    await test.step('reload the page', async () => {
      await page.reload()
      await editorPage.waitForReady()
    })

    await test.step('verify siteName still shows updated value', async () => {
      // The Settings entry should still be selected after reload
      await editorPage.verifyFieldValue('siteName', uniqueSiteName)
    })
  })

  test('single-entry type: navigator shows the type label, whatever its title says', async ({
    page,
  }) => {
    await test.step('open editor and open navigator', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
    })

    await test.step('the Settings entry is named "Settings", not its siteName "Test Site"', async () => {
      await expect(editorPage.navigatorItem('Settings')).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(editorPage.navigatorItem('Test Site')).toHaveCount(0)
    })

    await test.step('renaming the site leaves the label as it is after reload', async () => {
      await editorPage.selectEntry('Settings')
      await editorPage.closeContentNavigator()

      await editorPage.fillTextField('siteName', 'Renamed Site')
      await editorPage.saveAndVerify()

      // Reload so the navigator refreshes entry labels from the server
      await page.reload()
      await editorPage.waitForReady()

      await editorPage.openContentNavigator()
      await expect(editorPage.navigatorItem('Settings')).toBeVisible({ timeout: STANDARD_TIMEOUT })
      await expect(editorPage.navigatorItem('Renamed Site')).toHaveCount(0)
    })
  })

  test('a multi-entry type: a post is named by its title, which follows a saved edit', async ({
    page,
  }) => {
    const stamp = Date.now()
    await test.step('create a titled post', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.createPost(`titled-${stamp}`, `Titled Post ${stamp}`)
    })

    await test.step('retitle it, and the navigator follows after reload', async () => {
      await editorPage.fillTextField('title', `Retitled Post ${stamp}`)
      await editorPage.saveAndVerify()
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()
      const posts = editorPage.navigatorItem('Posts')
      if (!(await editorPage.isCollectionExpanded('Posts'))) await posts.click()
      await expect(editorPage.navigatorItem(`Retitled Post ${stamp}`)).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
      await expect(editorPage.navigatorItem(`Titled Post ${stamp}`)).toHaveCount(0)
    })
  })

  test('new YAML entry can be found by content prefix', async () => {
    await test.step('verify seeded settings file exists in main branch', async () => {
      const filename = await findContentFile('settings.settings.')
      expect(filename).toBeTruthy()
      expect(filename).toMatch(/\.yaml$/)
    })

    await test.step('verify file content is valid YAML', async () => {
      const raw = await readRawContentFile(SETTINGS_CONTENT_PATH)
      expect(raw).toContain('siteName:')
      expect(raw).toContain('maintenanceMode:')
      // Should not be JSON
      expect(raw.trim()).not.toMatch(/^\{/)
    })
  })
})
