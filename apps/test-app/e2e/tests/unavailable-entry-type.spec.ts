import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { BASE_URL } from '../fixtures/base-url'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch, getMainBranchPath } from '../fixtures/test-workspace'
import { bumpResourceGeneration } from '../../../../packages/canopycms/src/resource-generation'

/**
 * Content synced ahead of the code that registers its entry schema: a collection whose
 * `.collection.json` names a schema the running app does not define. The editor must say so for
 * that collection and entry, and keep every other collection working. resetWorkspace's
 * `git clean` removes the seeded, untracked collection.
 */
test.describe('Unavailable entry type', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    await test.step('seed a collection naming an unregistered schema', async () => {
      const mainPath = getMainBranchPath()
      const dir = path.join(mainPath, 'content', 'widgets.wIdGeTsDiR12')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, '.collection.json'),
        JSON.stringify({
          name: 'widgets',
          label: 'Widgets',
          entries: [{ name: 'widget', format: 'json', schema: 'widgetSchema' }],
          order: [],
        }),
      )
      await fs.writeFile(
        path.join(dir, 'widget.alpha.aLpHaaLpHa12.json'),
        JSON.stringify({ title: 'Alpha' }),
      )
      // Content changed under the server's feet: bump, never delete (see test-workspace.ts).
      await bumpResourceGeneration(mainPath, 'schema')
      await bumpResourceGeneration(mainPath, 'content-index')
    })
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('says so for that collection and entry, and leaves the rest of the editor working', async ({
    page,
  }) => {
    await editorPage.goto()
    await editorPage.waitForReady()
    await editorPage.openContentNavigator()

    await test.step('the navigator names the unknown content type once, under its collection', async () => {
      const messages = editorPage.contentNavigator.getByTestId('unavailable-type-message')
      await expect(messages).toHaveCount(1)
      await expect(messages).toContainText('widgetSchema')
      await expect(messages).toContainText("doesn't know yet")
    })

    await test.step('opening its entry shows the notice in place of the form', async () => {
      await editorPage.toggleCollection('Widgets')
      await editorPage.navigatorItem('Alpha').click()
      const notice = page.getByTestId('unavailable-entry-notice')
      await expect(notice).toBeVisible()
      await expect(notice).toContainText('widgetSchema')
      await expect(editorPage.formPane.locator('input[data-canopy-field]')).toHaveCount(0)
    })

    await test.step('a healthy entry still opens into its form', async () => {
      await editorPage.openContentNavigator()
      await editorPage.selectEntry('Home Page')
      await expect(page.getByTestId('unavailable-entry-notice')).toHaveCount(0)
      await expect(editorPage.formPane.locator('[data-canopy-field]').first()).toBeVisible()
    })

    await expect(page.getByText(/internal server error/i)).toHaveCount(0)
    await expect(page.getByText(/application error/i)).toHaveCount(0)
  })
})
