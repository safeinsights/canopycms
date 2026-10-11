import { BASE_URL } from '../fixtures/base-url'
import { test, expect } from '@playwright/test'
import { EditorPage } from '../fixtures/editor-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import { SHORT_TIMEOUT, STANDARD_TIMEOUT } from '../fixtures/timeouts'

/**
 * E2E tests for entry CRUD operations.
 */
test.describe('Entry CRUD Operations', () => {
  let editorPage: EditorPage

  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    editorPage = new EditorPage(page)
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('create a new entry', async ({ page }) => {
    const testSlug = `test-post-${Date.now()}`

    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open entry navigator', async () => {
      await editorPage.openContentNavigator()
      await expect(editorPage.contentNavigator).toBeVisible()
    })

    await test.step('create a Posts entry from the collection menu', async () => {
      await editorPage.createEntry('Posts', testSlug)
    })

    await test.step('verify new entry appears in navigator', async () => {
      // The entry label comes from the entry type label ("Post"), not the slug.
      // The Posts collection should be auto-expanded after creation.
      const navItem = editorPage.navigatorItem('Post')
      await expect(navItem).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })

    await test.step('reload and verify persistence', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()

      const postsCollection = editorPage.navigatorItem('Posts')
      await postsCollection.waitFor({
        state: 'visible',
        timeout: STANDARD_TIMEOUT,
      })

      // The editor restores the created entry after reload, and the navigator
      // auto-expands the path to the current entry (EntryNavigator merges
      // calculatePathToEntry into the expanded state). Only click to expand
      // when the entry hasn't appeared — an unconditional click would toggle
      // the collection collapsed and hide the entry we're asserting on. Give
      // auto-expand a short grace window (not an instant isVisible check) so
      // it can't land between the check and the click.
      const navItem = editorPage.navigatorItem('Post')
      await navItem
        .waitFor({ state: 'visible', timeout: 1500 })
        .catch(() => editorPage.toggleCollection('Posts'))
      await expect(navItem).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('rename an entry', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open entry navigator', async () => {
      await editorPage.openContentNavigator()
      await expect(editorPage.contentNavigator).toBeVisible()
    })

    await test.step('create a post entry (setup)', async () => {
      await editorPage.createEntry('Posts', 'post-to-rename')

      // Wait for entry to appear in navigator
      await expect(editorPage.navigatorItem('Post')).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('rename the entry through its context menu', async () => {
      await editorPage.renameEntry('Post', 'renamed-post')
    })

    await test.step('reload and verify renamed entry persists', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()

      // Expand the Posts collection (collapsed after reload)
      await editorPage.navigatorItem('Posts').waitFor({
        state: 'visible',
        timeout: STANDARD_TIMEOUT,
      })
      await editorPage.toggleCollection('Posts')

      // Label stays "Post" (rename only changes slug, not the display label)
      await expect(editorPage.navigatorItem('Post')).toBeVisible({ timeout: STANDARD_TIMEOUT })
    })
  })

  test('delete an entry', async ({ page }) => {
    await test.step('open editor', async () => {
      await editorPage.goto()
      await editorPage.waitForReady()
    })

    await test.step('open entry navigator', async () => {
      await editorPage.openContentNavigator()
      await expect(editorPage.contentNavigator).toBeVisible()
    })

    await test.step('create a post entry (setup)', async () => {
      await editorPage.createEntry('Posts', 'post-to-delete')

      await expect(editorPage.navigatorItem('Post')).toBeVisible({
        timeout: STANDARD_TIMEOUT,
      })
    })

    await test.step('delete the entry through its context menu and confirm', async () => {
      await editorPage.deleteEntry('Post')
    })

    await test.step('verify entry is removed from navigator', async () => {
      await expect(editorPage.navigatorItem('Post')).not.toBeVisible({ timeout: STANDARD_TIMEOUT })
    })

    await test.step('reload and verify entry is gone', async () => {
      await page.reload()
      await editorPage.waitForReady()
      await editorPage.openContentNavigator()

      // Expand Posts collection
      await editorPage.navigatorItem('Posts').waitFor({
        state: 'visible',
        timeout: STANDARD_TIMEOUT,
      })
      await editorPage.toggleCollection('Posts')

      await expect(editorPage.navigatorItem('Post')).not.toBeVisible({ timeout: SHORT_TIMEOUT })
    })
  })
})
