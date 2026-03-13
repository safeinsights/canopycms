# E2E Test Backlog

Each item below is a self-contained test scenario for a Claude session to implement.
Existing tests live in `apps/test-app/e2e/tests/`. Fixtures are in `apps/test-app/e2e/fixtures/`.
The test app runs on `http://localhost:5174` (started by `npm run dev -w canopycms-test-app`).

Use existing fixtures:
- `EditorPage` (`fixtures/editor-page.ts`) — navigate, select entries, fill/save fields
- `BranchPage` (`fixtures/branch-page.ts`) — branch create/switch/submit/delete
- `test-workspace.ts` — workspace and server setup
- `test-users.ts` — admin user credentials

---

## Entry CRUD Operations

### 1. Create a new entry
**Spec file:** `entry-crud.spec.ts`
**Scenario:** From the editor with the home collection open, click the "+" or "New Entry" button in the entry navigator. Verify the create-entry modal opens (`EntryCreateModal.tsx`). Fill in the slug/title fields. Submit. Verify the new entry appears in the navigator and the form is populated. Reload and verify persistence.
**data-testids needed:** Check `EntryCreateModal.tsx` for existing testids or add `data-testid="create-entry-button"`, `data-testid="entry-slug-input"`, `data-testid="create-entry-submit"`.
**Files to read first:** `packages/canopycms/src/editor/EntryCreateModal.tsx`, `packages/canopycms/src/editor/EntryNavigator.tsx`, `apps/test-app/e2e/fixtures/editor-page.ts`

### 2. Rename an entry
**Spec file:** `entry-crud.spec.ts`
**Scenario:** With an entry selected, open its context menu or find a rename action. Verify the rename modal opens (`RenameEntryModal.tsx`). Enter a new slug. Submit. Verify the navigator updates and the URL/slug reflects the new name. Reload and verify the renamed entry loads.
**data-testids needed:** Check `RenameEntryModal.tsx` for existing testids or add `data-testid="rename-entry-button"`, `data-testid="rename-slug-input"`, `data-testid="rename-entry-submit"`.
**Files to read first:** `packages/canopycms/src/editor/RenameEntryModal.tsx`

### 3. Delete an entry
**Spec file:** `entry-crud.spec.ts`
**Scenario:** Create a fresh entry (via API or UI), then trigger delete. Verify the confirm-delete modal opens (`ConfirmDeleteModal.tsx`). Confirm deletion. Verify the entry is removed from the navigator. Reload and verify it is gone.
**data-testids needed:** Check `ConfirmDeleteModal.tsx` for existing testids or add `data-testid="delete-entry-button"`, `data-testid="confirm-delete-submit"`.
**Files to read first:** `packages/canopycms/src/editor/ConfirmDeleteModal.tsx`

---

## Field Types (Unskip / New)

### 4. MDX / textarea field editing
**Spec file:** `field-types.spec.ts` (unskip or replace existing skipped tests)
**Scenario:** The existing tests are skipped with TODO "Rewrite to create post via API". Create a post entry via the Canopy API (POST to the test server) instead of via UI, then open it in the editor. Edit the `body` textarea field. Save. Reload and verify persistence.
**Context:** The posts collection has an MDX `body` field. The API route is `/api/canopy/[...canopy]`. Look at `apps/test-app/e2e/tests/field-types.spec.ts` for the skipped tests and the TODO comment. Look at `packages/canopycms/src/api/` for the write-entry endpoint.
**Files to read first:** `apps/test-app/e2e/tests/field-types.spec.ts`, `packages/canopycms/src/api/routes/`

### 5. Toggle (boolean) field
**Spec file:** `field-types.spec.ts`
**Scenario:** Add a boolean/toggle field to the test app's home schema. Open the entry. Toggle it on and off. Save. Reload and verify the persisted value.
**data-testids needed:** Add `data-testid="field-toggle-{fieldName}"` or use `data-canopy-field` on the toggle input in `packages/canopycms/src/editor/fields/ToggleField.tsx`.
**Files to read first:** `packages/canopycms/src/editor/fields/ToggleField.tsx`, `apps/test-app/canopycms.config.ts` (or schema file)

### 6. Select (enum) field
**Spec file:** `field-types.spec.ts`
**Scenario:** Add a select field to the test app schema. Open the entry. Change the selected value. Save. Reload and verify persistence.
**data-testids needed:** Add `data-canopy-field` on the select in `packages/canopycms/src/editor/fields/SelectField.tsx`.
**Files to read first:** `packages/canopycms/src/editor/fields/SelectField.tsx`

### 7. List field — add and remove items
**Spec file:** `field-types.spec.ts`
**Scenario:** The home schema has a `featuredPosts` list field. Open the home entry. Add a new list item. Verify it appears. Remove it. Save. Reload and verify the list state.
**data-testids needed:** Add `data-testid="list-add-item-{fieldName}"`, `data-testid="list-remove-item-{fieldName}-{index}"` to the list field component. Find the component at `packages/canopycms/src/editor/fields/` (look for list/array field).
**Files to read first:** `packages/canopycms/src/editor/fields/`, `packages/canopycms/src/editor/FormRenderer.tsx`

---

## Discard Draft

### 8. Discard file draft
**Spec file:** `editor-happy-path.spec.ts` (add test) or new `discard-draft.spec.ts`
**Scenario:** Make edits to an entry. Verify the save button is enabled and a "discard" or "revert" action is available. Click discard. Verify the field values revert to their last-saved state without a page reload.
**data-testids needed:** Find `data-testid` for the discard button in `packages/canopycms/src/editor/Editor.tsx`. Search for "discard" or "revert" in that file.
**Files to read first:** `packages/canopycms/src/editor/Editor.tsx` (search for discard), `apps/test-app/e2e/fixtures/editor-page.ts`

---

## Preview Bridge

### 9. Preview focus — click preview element to jump to editor field
**Spec file:** `preview-bridge.spec.ts`
**Scenario:** Open the editor with the home entry. In the preview pane (iframe), click an element that has a `data-canopy-path` attribute. Verify that the corresponding field in the form pane scrolls into view and/or receives focus.
**Context:** The preview bridge is implemented in `packages/canopycms/src/editor/preview-bridge.tsx`. Look for how `data-canopy-path` attributes are used and how the bridge communicates click events. The test app's public page (the preview target) may or may not have these attributes — check `apps/test-app/app/page.tsx`.
**Files to read first:** `packages/canopycms/src/editor/preview-bridge.tsx`, `apps/test-app/app/page.tsx`, existing preview tests in `field-types.spec.ts`

### 10. Preview reflects live edits without save
**Spec file:** `preview-bridge.spec.ts`
**Scenario:** Type into a field. Before saving, verify the preview pane updates with the new content (draft mode). Verify the preview shows the old content before editing begins.
**Context:** Partially covered by `field-types.spec.ts` (waitForPreviewUpdate). Expand to verify the actual content rendered in the iframe changes.
**Files to read first:** `apps/test-app/e2e/tests/field-types.spec.ts`, `packages/canopycms/src/editor/preview-bridge.tsx`

---

## Comments System

### 11. Add a branch-level comment
**Spec file:** `comments.spec.ts`
**Scenario:** Create a branch. Open the branch manager or comments panel. Add a branch-level comment. Verify it appears in the comments list. Reload and verify persistence.
**Context:** Comments are stored in the branch clone. Look at `packages/canopycms/src/editor/CommentsPanel.tsx` and `BranchComments.tsx`. The comments panel may be opened via a button in the editor header or branch manager.
**data-testids needed:** Find or add testids for comment panel open button, comment textarea, comment submit button, comment list items.
**Files to read first:** `packages/canopycms/src/editor/CommentsPanel.tsx`, `packages/canopycms/src/editor/BranchComments.tsx`

### 12. Add and resolve a field-level comment thread
**Spec file:** `comments.spec.ts`
**Scenario:** Select an entry and field. Trigger a field-level comment (look for a comment icon near the field or in the preview). Add a comment. Verify an inline comment thread appears (`InlineCommentThread.tsx`). Resolve/close the thread. Verify it is marked resolved.
**Files to read first:** `packages/canopycms/src/editor/InlineCommentThread.tsx`, `packages/canopycms/src/editor/EntryComments.tsx`, `packages/canopycms/src/editor/ThreadCarousel.tsx`

---

## Branch Workflow Extensions

### 13. Approve a submitted branch (if UI exists)
**Spec file:** `branch-workflow.spec.ts` (add test)
**Scenario:** Check if there is an in-editor "Approve" action (separate from the GitHub PR flow). Look at `BranchManager.tsx` for approve button / reviewer approval UI. If it exists, test: create branch → submit → switch to reviewer user → approve → verify branch status changes.
**Context:** Current branch tests check that non-reviewers cannot see request-changes, but approval may go through GitHub only. Verify by reading `packages/canopycms/src/editor/BranchManager.tsx`.
**Files to read first:** `packages/canopycms/src/editor/BranchManager.tsx`, `apps/test-app/e2e/tests/branch-workflow.spec.ts`

### 14. Branch switching preserves editor state
**Spec file:** `branch-workflow.spec.ts` (add test)
**Scenario:** Open branch A, edit an entry but do NOT save. Switch to branch B. Verify branch B loads correctly. Switch back to branch A. Verify the unsaved draft is preserved (or document expected behavior if it's discarded).
**Files to read first:** `apps/test-app/e2e/fixtures/branch-page.ts`, `packages/canopycms/src/editor/Editor.tsx`

---

## Entry Navigator

### 15. Entry navigator — keyboard navigation
**Spec file:** `entry-navigator.spec.ts`
**Scenario:** Open the entry navigator. Use arrow keys to navigate between entries. Press Enter to select. Verify the form pane updates to the selected entry.
**Files to read first:** `packages/canopycms/src/editor/EntryNavigator.tsx`

### 16. Entry navigator — search/filter
**Spec file:** `entry-navigator.spec.ts`
**Scenario:** If the entry navigator has a search/filter input, type a query. Verify the entry list filters. Clear the query and verify all entries return.
**Context:** Check `EntryNavigator.tsx` for a search input.
**Files to read first:** `packages/canopycms/src/editor/EntryNavigator.tsx`

---

## Error & Edge Cases

### 17. Save failure shows error notification
**Spec file:** `error-handling.spec.ts`
**Scenario:** Intercept the save API call and force it to return a 500 error (use Playwright's `page.route()`). Make an edit and click save. Verify an error notification appears (Mantine notification with error styling).
**Context:** Notifications use Mantine's notification system. The selector `.mantine-Notification-root` already exists in fixtures.
**Files to read first:** `apps/test-app/e2e/fixtures/editor-page.ts`, `packages/canopycms/src/editor/Editor.tsx` (save error handling)

### 18. Editor loads with no entries in collection
**Spec file:** `error-handling.spec.ts`
**Scenario:** Navigate to the editor with a collection that has no entries. Verify the UI handles this gracefully (empty state message, no crash). Optionally verify the "create entry" action is still available.
**Context:** May require creating a test collection with no entries or using the API to delete all entries from a test branch.
**Files to read first:** `packages/canopycms/src/editor/EntryNavigator.tsx`, `packages/canopycms/src/editor/Editor.tsx`

---

## Notes for Implementers

- Run existing tests first: `npx playwright test --project chromium` from repo root
- Check `playwright.config.ts` for config (timeout: 90s, workers: 1, base URL: `http://localhost:5174`)
- When adding `data-testid` attributes, add them to the component in `packages/canopycms/src/editor/` and reference them in the test
- The test app schema is at `apps/test-app/canopycms.config.ts` — adding fields there is acceptable for new field-type tests
- Keep tests sequential (no parallel) due to shared filesystem workspace
