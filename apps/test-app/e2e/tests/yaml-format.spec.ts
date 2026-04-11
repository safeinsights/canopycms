import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import {
  resetWorkspace,
  ensureMainBranch,
  readRawContentFile,
  findContentFile,
} from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

const BASE_URL = 'http://localhost:5174'

// The settings YAML file is seeded from content/ into the main branch workspace.
const SETTINGS_CONTENT_PATH = 'settings.settings.sEtTiNgS5678.yaml'

/**
 * E2E tests for YAML content format support and the isTitle field flag.
 *
 * The settings entry type uses YAML format and has isTitle: true on siteName,
 * so it also exercises the isTitle navigator display feature.
 */
test.describe('YAML Format and isTitle Flag', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, { __E2E_TEST__: true })
    })
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
      await editorPage.openEntryNavigator()
      // isTitle: true on siteName means the navigator shows the siteName value "Test Site"
      await editorPage.selectEntry('Test Site')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
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
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Test Site')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })
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
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Test Site')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })

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

  test('isTitle flag: navigator shows siteName value as entry label', async ({ page }) => {
    await test.step('open editor and open navigator', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
    })

    await test.step('verify Settings entry appears with isTitle value "Test Site"', async () => {
      // With isTitle: true on siteName (value = "Test Site"), the navigator label
      // should be "Test Site" rather than the entry type label "Settings"
      const navItem = page.locator('[data-testid="entry-nav-item-test-site"]')
      await expect(navItem).toBeVisible({ timeout: STANDARD_TIMEOUT })

      // The entry type label "Settings" should NOT appear as a nav item
      // (it's still the collection label, but not the individual entry label)
      const settingsTypeItem = page.locator('[data-testid="entry-nav-item-settings"]')
      await expect(settingsTypeItem).not.toBeVisible()
    })

    await test.step('update siteName and verify navigator label updates after reload', async () => {
      // Select the entry
      await editorPage.selectEntry('Test Site')
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: SHORT_TIMEOUT })

      // Change siteName
      await editorPage.fillTextField('siteName', 'Renamed Site')
      await editorPage.saveAndVerify()

      // Reload so the navigator refreshes entry labels from the server
      await page.reload()
      await editorPage.waitForReady()

      // Open navigator and verify the updated label
      await editorPage.openEntryNavigator()
      const renamedItem = page.locator('[data-testid="entry-nav-item-renamed-site"]')
      await expect(renamedItem).toBeVisible({ timeout: STANDARD_TIMEOUT })
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
