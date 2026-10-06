import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type Page } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import {
  resetWorkspace,
  ensureMainBranch,
  findContentFile,
  readContentFile,
  writeContentFile,
} from '../fixtures/test-workspace'
import { STANDARD_TIMEOUT, LONG_TIMEOUT } from '../fixtures/timeouts'

/**
 * A body containing JSX elements, or anything else MDXEditor cannot load, must
 * still reach the saved entry when edited.
 */
test.describe('Body with JSX elements', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  /** Create a post, then replace its stored body and reload so the editor loads it. */
  async function postWithBody(page: Page, slug: string, body: string): Promise<string> {
    await editorPage.goto()
    await editorPage.waitForReady()
    await editorPage.createPost(slug, `Post ${slug}`)
    const relPath = await findContentFile(`posts.qrstuvwxyz12/post.${slug}.`)
    expect(relPath).toBeTruthy()
    const data = await readContentFile<Record<string, unknown>>(relPath!)
    await writeContentFile(relPath!, { ...data, body })
    await page.reload()
    await editorPage.waitForReady()
    return relPath!
  }

  test('edits around and inside an element are saved', async ({ page }) => {
    const relPath = await postWithBody(
      page,
      'jsx-body',
      [
        'Intro paragraph.',
        '',
        '<Callout type="info" title="Note">',
        'Callout text.',
        '</Callout>',
        '',
        'Inline <Badge color="red">new</Badge> text.',
      ].join('\n'),
    )

    // Scoped to the rich editor's DOM: until its chunk loads, the field shows
    // the body as text in a read-only textarea, which getByText also matches.
    const richEditor = page.locator('.canopy-mdx-content')
    await test.step('the element loads in the rich editor', async () => {
      await expect(richEditor.getByTestId('mdx-jsx-tag').first()).toHaveText(
        '<Callout type="info" title="Note">',
        { timeout: LONG_TIMEOUT },
      )
      await expect(page.getByTestId('markdown-source-fallback')).toHaveCount(0)
    })

    await test.step('edit the paragraph, then the element', async () => {
      await richEditor.locator('p', { hasText: 'Intro paragraph.' }).click()
      await page.keyboard.press('End')
      await page.keyboard.type(' Edited intro.')
      await richEditor.locator('.canopy-mdx-jsx p', { hasText: 'Callout text.' }).click()
      await page.keyboard.press('End')
      await page.keyboard.type(' Edited callout.')
    })

    // Save straight from inside the element: the click that moves focus out
    // of it is what copies its content into the document.
    await test.step('save', () => editorPage.saveAndVerify())

    await test.step('both edits and the element are on disk', async () => {
      const { body } = await readContentFile<{ body: string }>(relPath)
      expect(body).toContain('Intro paragraph. Edited intro.')
      expect(body).toMatch(
        /<Callout type="info" title="Note">\s+Callout text\. Edited callout\.\s+<\/Callout>/,
      )
      expect(body).toContain('<Badge color="red">new</Badge>')
    })
  })

  test('a body the rich editor cannot load is edited and saved as source', async ({ page }) => {
    const relPath = await postWithBody(page, 'unparseable-body', 'Line one<br>line two')

    const source = page.locator('[data-testid="markdown-source-editor"]')
    await test.step('the body opens as source with an explanation', async () => {
      await expect(page.locator('[data-testid="markdown-source-fallback"]')).toBeVisible({
        timeout: LONG_TIMEOUT,
      })
      await expect(source).toHaveValue('Line one<br>line two', { timeout: STANDARD_TIMEOUT })
    })

    await test.step('edit and save', async () => {
      await source.fill('Line one<br />line two, edited')
      await editorPage.saveAndVerify()
    })

    await test.step('the edit is on disk', async () => {
      const { body } = await readContentFile<{ body: string }>(relPath)
      expect(body).toBe('Line one<br />line two, edited')
    })
  })
})
