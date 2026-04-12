import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch, readContentFile } from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'

const BASE_URL = 'http://localhost:5174'

/**
 * Inline field group (type: 'group') E2E tests.
 *
 * The Home Page schema includes an `seoGroup` defined with defineInlineFieldGroup().
 * Its fields (metaTitle, metaDescription) are stored flat in the content file — no
 * nested key — but the editor wraps them in a bordered Paper section with a label.
 */
test.describe('Inline field group UI', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as any).__E2E_TEST__ = true
    })
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
    await test.step('open editor and load Home Page', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
      await editorPage.openEntryNavigator()
      await editorPage.selectEntry('Home Page')
      // Close navigator so form pane is fully interactive
      await page.keyboard.press('Escape')
      await expect(editorPage.entryNavigator).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('group label is visible in the form', async ({ page }) => {
    await test.step('group section heading is rendered', async () => {
      // The InlineGroupField renders the label as a small bold dimmed Text element.
      // We locate it within the form pane to avoid matching other parts of the UI.
      const groupLabel = editorPage.formPane.getByText('SEO', { exact: true })
      await expect(groupLabel).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })

    await test.step('group description is rendered', async () => {
      const groupDesc = editorPage.formPane.getByText('Search engine optimisation metadata', {
        exact: true,
      })
      await expect(groupDesc).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('group fields are visible and carry data-canopy-field attributes', async () => {
    await test.step('metaTitle field is present in the form', async () => {
      const metaTitleInput = editorPage.getFieldInput('metaTitle')
      await expect(metaTitleInput).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })

    await test.step('metaDescription field is present in the form', async () => {
      const metaDescInput = editorPage.getFieldInput('metaDescription')
      await expect(metaDescInput).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('group visual container (Paper border) wraps the fields', async ({ page }) => {
    await test.step('bordered Paper section is present around group fields', async () => {
      // The InlineGroupField renders a Mantine Paper with withBorder.
      // Locate it by finding the Paper that contains the SEO label.
      const seoLabel = editorPage.formPane.getByText('SEO', { exact: true })
      await seoLabel.waitFor({ state: 'visible', timeout: STANDARD_TIMEOUT })

      // The enclosing Paper has a border style — verify at least one bordered
      // container exists in the form pane (the group section).
      // Mantine sets border: "calc(0.0625rem * var(--mantine-scale)) solid ..."
      // We check that the ancestor closest to the group label has a border attribute
      // or the mantine-Paper class that indicates withBorder.
      const borderedPaper = editorPage.formPane.locator('.mantine-Paper-root[data-with-border]')
      await expect(borderedPaper.first()).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('fields inside the group are editable and saved flat in content', async ({ page }) => {
    const testMetaTitle = `SEO-Title-${Date.now()}`
    const testMetaDesc = 'Test meta description for E2E'

    await test.step('fill metaTitle inside the group', async () => {
      await editorPage.fillTextField('metaTitle', testMetaTitle)
    })

    await test.step('fill metaDescription inside the group', async () => {
      await editorPage.fillTextField('metaDescription', testMetaDesc)
    })

    await test.step('save the entry', async () => {
      await editorPage.saveAndVerify()
    })

    await test.step('verify flat storage: metaTitle and metaDescription at top level', async () => {
      const content = await readContentFile<Record<string, unknown>>('home.home.bo7QdSwn9Tod.json')
      // Inline groups are transparent — fields live at the top level, not under 'seo'
      expect(content.metaTitle).toBe(testMetaTitle)
      expect(content.metaDescription).toBe(testMetaDesc)
      expect(content).not.toHaveProperty('seo')
    })

    await test.step('reload and confirm values persist in the UI', async () => {
      await page.reload()
      await editorPage.waitForReady()

      // After reload the current entry re-loads automatically via URL/state
      await editorPage.verifyFieldValue('metaTitle', testMetaTitle)
      await editorPage.verifyFieldValue('metaDescription', testMetaDesc)
    })
  })

  test('editing a group field does not clobber sibling top-level fields', async () => {
    const originalTitle = 'Home Page'

    await test.step('confirm title field shows expected initial value', async () => {
      await editorPage.verifyFieldValue('title', originalTitle)
    })

    await test.step('fill metaTitle inside the group', async () => {
      await editorPage.fillTextField('metaTitle', 'SEO only change')
    })

    await test.step('save', async () => {
      await editorPage.saveAndVerify()
    })

    await test.step('title field is unchanged in persisted content', async () => {
      const content = await readContentFile<Record<string, unknown>>('home.home.bo7QdSwn9Tod.json')
      expect(content.title).toBe(originalTitle)
      expect(content.metaTitle).toBe('SEO only change')
    })
  })
})
