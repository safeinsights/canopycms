import { BASE_URL } from '../fixtures/base-url'
import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { EditorPage } from '../fixtures/editor-page'
import { AdminPage } from '../fixtures/admin-page'
import { switchUser, installE2EFlag } from '../fixtures/test-users'
import { resetWorkspace, ensureMainBranch } from '../fixtures/test-workspace'
import {
  seedTask,
  seedCorruptTaskFile,
  listTaskIds,
  taskFileExists,
} from '../fixtures/admin-workspace'

/** Navigate to the editor, open System health, and land on the Tasks tab. */
async function openTasksTab(page: Page): Promise<AdminPage> {
  const editorPage = new EditorPage(page)
  await editorPage.goto()
  await editorPage.waitForReady()
  const adminPage = new AdminPage(page)
  await adminPage.open()
  await adminPage.selectTab('Tasks')
  return adminPage
}

test.describe('Admin Task Recovery', () => {
  test.beforeEach(async ({ page }) => {
    await installE2EFlag(page)
    await test.step('reset workspace', () => resetWorkspace())
    await test.step('ensure main branch', () => ensureMainBranch(BASE_URL))
    await test.step('switch user', () => switchUser(page, 'admin'))
  })

  test('Tasks tab defaults to the Failed filter', async ({ page }) => {
    const adminPage = await openTasksTab(page)
    // resetWorkspace() clears the whole queue, so an empty "No failed tasks."
    // state here is itself proof the initial filter is 'failed' -- if it
    // defaulted to something else this text (or its "No <status> tasks."
    // sibling) would read differently only once tasks are seeded per-bucket.
    await expect(adminPage.panel.getByText('No failed tasks.')).toBeVisible()
  })

  test('retry requeues a failed task under a brand-new id', async ({ page }) => {
    const originalId = randomUUID()
    await seedTask('failed', { id: originalId, action: 'push', error: 'boom' })

    const adminPage = await openTasksTab(page)
    await adminPage.retryTaskButton(originalId).click()
    await adminPage.confirmDialog('Retry task', 'Retry')

    // requeueFailedTask() mints a fresh crypto.randomUUID() rather than
    // reusing the original id -- dequeueTask()/recoverOrphanedTasks() dedup
    // against completed/ and failed/ by id, so a same-id copy in pending/
    // would be silently eaten and never actually run. This is the single
    // most important invariant in the recovery surface: getting it wrong
    // means "Retry" silently does nothing.
    const notification = page.locator('.mantine-Notification-root', {
      hasText: 'Task requeued as',
    })
    await expect(notification).toBeVisible()

    await expect.poll(() => taskFileExists('failed', originalId)).toBe(false)
    const pendingIds = await listTaskIds('pending')
    expect(pendingIds).toHaveLength(1)
    expect(pendingIds[0]).not.toBe(originalId)

    const notificationText = await notification.textContent()
    expect(notificationText).toContain(pendingIds[0])
  })

  test('delete removes a failed task file', async ({ page }) => {
    const id = randomUUID()
    await seedTask('failed', { id })

    const adminPage = await openTasksTab(page)
    await adminPage.deleteTaskButton(id).click()
    await adminPage.confirmDialog('Delete task file', 'Delete')

    await expect.poll(() => taskFileExists('failed', id)).toBe(false)
  })

  test('delete from Pending warns the worker may already have picked it up', async ({ page }) => {
    const id = randomUUID()
    await seedTask('pending', { id })

    const adminPage = await openTasksTab(page)
    await adminPage.selectTaskFilter('Pending')
    await adminPage.deleteTaskButton(id).click()

    const dialog = page.getByRole('dialog', { name: 'Delete task file' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('worker may already have picked this task up')
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(dialog).toBeHidden()

    await expect.poll(() => taskFileExists('pending', id)).toBe(false)
  })

  test('corrupt file row shows the file name and a raw snippet, and is deletable', async ({
    page,
  }) => {
    const fileName = `broken-${Date.now()}.json`
    await seedCorruptTaskFile(fileName, '{ not json')

    const adminPage = await openTasksTab(page)
    await adminPage.selectTaskFilter('Corrupt')

    await expect(adminPage.panel.getByText(fileName)).toBeVisible()
    await expect(adminPage.panel.getByText('{ not json')).toBeVisible()

    await adminPage.deleteTaskButton(fileName).click()
    await adminPage.confirmDialog('Delete task file', 'Delete')

    const idOnDisk = fileName.replace(/\.json$/, '')
    await expect.poll(() => taskFileExists('corrupt', idOnDisk)).toBe(false)
  })

  test('empty state renders "No {status} tasks." per bucket', async ({ page }) => {
    const adminPage = await openTasksTab(page)
    await expect(adminPage.panel.getByText('No failed tasks.')).toBeVisible()

    await adminPage.selectTaskFilter('Pending')
    await expect(adminPage.panel.getByText('No pending tasks.')).toBeVisible()

    await adminPage.selectTaskFilter('Corrupt')
    await expect(adminPage.panel.getByText('No corrupt tasks.')).toBeVisible()
  })
})
