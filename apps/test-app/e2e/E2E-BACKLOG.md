# E2E Test Backlog

## Session Instructions (for Claude)

Pick the first ⬜ item below and implement it end-to-end. Follow these steps:

1. **Read** the files listed under "Files to read first" for that item, plus any components it references.
2. **Add `data-testid` attributes** to the relevant editor components in `packages/canopycms/src/editor/` as needed.
3. **Write the test** in the spec file listed. Mirror the pattern from `apps/test-app/e2e/tests/editor-happy-path.spec.ts`:
   - `beforeEach`: `resetWorkspace()`, `ensureMainBranch()`, `switchUser(page, 'admin')`
   - Use `test.step()` to name each phase clearly
   - Use `data-testid` selectors; fall back to ARIA roles (`page.getByRole(...)`) for Mantine modals/dialogs (Mantine keeps modal root divs in the DOM when closed — put `data-testid` on an element **inside** the modal content, not on `<Modal>` itself)
4. **Run the test** using MCP Playwright tools (`mcp__playwright__*`) to observe the live browser, then also run via terminal: `npx playwright test <spec-name> --project chromium` from the repo root. The test server auto-starts if not already running.
5. **Iterate** until the test passes (green). Read the error context file at `test-results/.../error-context.md` and take screenshots via MCP to debug failures.
6. **Update this file**: mark the item ✅, add a `**Status:**` line, and add `**Notes:**` with any gotchas discovered.
7. **Provide a commit message** (but do NOT run `git add` or `git commit`).

### Key gotchas learned so far
- Mantine `<Modal>` renders a root wrapper div that is always in the DOM (hidden when closed). Put `data-testid` on a child element inside the modal body, not on `<Modal>` itself.
- Navigator item labels (`entry-nav-item-{label}`) use the entry's **display label** (often the entry type label for new entries with no title), not the slug.
- After a page reload, collection tree nodes are collapsed — click the collection node to expand before checking for child entries.
- Use `page.getByRole('dialog', { name: '...' })` as an alternative to `data-testid` for detecting modal open/close.

---

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

### 1. ✅ Create a new entry
**Status:** Done — `entry-crud.spec.ts` › "create a new entry"
**Spec file:** `entry-crud.spec.ts`
**Scenario:** From the editor with the home collection open, click the "+" or "New Entry" button in the entry navigator. Verify the create-entry modal opens (`EntryCreateModal.tsx`). Fill in the slug/title fields. Submit. Verify the new entry appears in the navigator and the form is populated. Reload and verify persistence.
**data-testids added:** `data-testid="entry-slug-input"` on slug TextInput, `data-testid="create-entry-submit"` on Create button (both in `EntryCreateModal.tsx`); `data-testid="add-entry-menu-item"` on "Add Entry" Menu.Item in `EntryNavigator.tsx`.
**Notes:** Modal testid must go on inner `<Stack>`, not `<Modal>` (Mantine keeps the root div in DOM when closed). Navigator label for a new entry is the entry type label ("Post"), not the slug.

### 2. ✅ Rename an entry
**Status:** Done — `entry-crud.spec.ts` › "rename an entry"
**Spec file:** `entry-crud.spec.ts`
**Scenario:** With an entry selected, open its context menu or find a rename action. Verify the rename modal opens (`RenameEntryModal.tsx`). Enter a new slug. Submit. Verify the navigator updates and the URL/slug reflects the new name. Reload and verify the renamed entry loads.
**data-testids added:** `data-testid="rename-entry-modal"` on inner `<Stack>`, `data-testid="rename-slug-input"` on TextInput, `data-testid="rename-entry-submit"` on Rename button (all in `RenameEntryModal.tsx`); `data-testid="rename-entry-menu-item"` on "Rename Entry" Menu.Item in `EntryNavigator.tsx`.
**Notes:** Test creates an entry first (workspace is reset in beforeEach). The entry context menu trigger testid is `entry-menu-{label}` — for a new post with no title, label is "Post" so testid is `entry-menu-post`. Rename only changes the slug/filename; the display label stays "Post" since the title field is empty.

### 3. ✅ Delete an entry
**Status:** Done — `entry-crud.spec.ts` › "delete an entry"
**Spec file:** `entry-crud.spec.ts`
**Scenario:** Create a fresh entry (via API or UI), then trigger delete. Verify the confirm-delete modal opens (`ConfirmDeleteModal.tsx`). Confirm deletion. Verify the entry is removed from the navigator. Reload and verify it is gone.
**data-testids added:** `data-testid="confirm-delete-modal"` on inner `<Stack>`, `data-testid="confirm-delete-submit"` on the red Delete button (both in `ConfirmDeleteModal.tsx`); `data-testid="delete-entry-menu-item"` on "Delete Entry" Menu.Item in `EntryNavigator.tsx`.
**Notes:** Test creates an entry first via UI. After deletion, `not.toBeVisible()` passes whether the element is hidden or absent from DOM. After reload + expand Posts, the entry should be gone entirely.

---

## Field Types (Unskip / New)

### 4. ✅ MDX / textarea field editing
**Status:** Done — `field-types.spec.ts` › "textarea/MDX field: multi-line content" (unskipped)
**Spec file:** `field-types.spec.ts`
**Scenario:** Create a post entry via the UI, edit the `body` rich text field, save, reload and verify persistence.
**Notes:** No API creation needed — UI creation (same pattern as entry-crud tests) works fine. The body field is a BlockNote-style rich text editor with ARIA role `textbox` and name `"editable markdown"` — interact via `page.getByRole('textbox', { name: 'editable markdown' })`. Key gotcha: after creating the entry, the navigator drawer is still open and its overlay blocks clicks on the form pane — press `Escape` to close the drawer before interacting with form fields.

### 5. ✅ Toggle (boolean) field
**Status:** Done — `field-types.spec.ts` › "toggle (boolean) field: on/off and persistence"
**Spec file:** `field-types.spec.ts`
**Scenario:** Add a boolean/toggle field to the test app's home schema. Open the entry. Toggle it on and off. Save. Reload and verify the persisted value.
**data-testids added:** `data-testid="field-toggle-{fieldName}"` via `wrapperProps` in `ToggleField.tsx` (put on the visible root wrapper div, not on the hidden `<input>`); `testId` prop passed from `FormRenderer.tsx` using `field.name`.
**Notes:** Mantine `Switch` puts extra props on the hidden `<input>` element (e.g., `data-testid`). Use `wrapperProps={{ 'data-testid': testId }}` to put the testid on the visible root wrapper div instead. Then `toggle.locator('input[type="checkbox"]')` gives the hidden input for `toBeChecked()` assertions. Clicking the wrapper div toggles the switch.

---

## Discard Draft

### 8. ✅ Discard file draft
**Status:** Done — `draft-behavior.spec.ts` › "discard file draft reverts field to last-saved state", "unsaved draft survives a page reload"
**Spec file:** `draft-behavior.spec.ts` (new file)
**Scenario:** Make edits to an entry. Verify the save button is enabled and a "discard" or "revert" action is available. Click discard. Verify the field values revert to their last-saved state without a page reload.
**data-testids added:** `data-testid="discard-file-draft-menu-item"` on the "Discard File Draft" `<Menu.Item>` in `EditorHeader.tsx`.
**Notes:** No confirmation dialog — discard immediately clears the draft from state and localStorage, shows "Draft cleared for file" (blue Mantine notification). Save button is `disabled` when no unsaved changes (`!hasUnsavedChanges`), so can use `toBeDisabled()` to verify clean state before and after. "Discard File Draft" is inside the file dropdown menu (same menu as "All Files" / `file-dropdown-button`).

---

## Preview Bridge

### 9. ✅ Preview focus — click preview element to jump to editor field
**Status:** Done — `preview-bridge.spec.ts` › "click preview element scrolls and highlights editor field"
**Spec file:** `preview-bridge.spec.ts` (new file)
**Scenario:** Open the editor with the home entry. In the preview pane (iframe), click an element that has a `data-canopy-path` attribute. Verify that the corresponding field in the form pane scrolls into view and/or receives focus.
**Changes to test app:** Added `apps/test-app/app/HomeView.tsx` (client component using `useCanopyPreview` and `fieldProps` to attach `data-canopy-path` attributes); updated `apps/test-app/app/page.tsx` to render `HomeView` instead of static HTML.
**Notes:** `[data-canopy-field="title"]` resolves to 2 elements (FieldWrapper div + input) — the focus handler uses `querySelector` which finds the FieldWrapper div first. Use `page.waitForFunction()` to poll the DOM for the transient box-shadow (1200ms window) instead of `toHaveCSS` (which has strict-mode issues with duplicate selectors). Preview sync: home entry previews at `/?branch=main`; after preview bridge sends data, the title element shows "Home Page" and is clickable. The `entryPath` in the focus message matches `currentEntry.previewSrc` (both `/?branch=main`).

### 10. ⬜ Preview reflects live edits without save
**Spec file:** `preview-bridge.spec.ts`
**Scenario:** Type into a field. Before saving, verify the preview pane updates with the new content (draft mode). Verify the preview shows the old content before editing begins.
**Context:** Partially covered by `field-types.spec.ts` (waitForPreviewUpdate). Expand to verify the actual content rendered in the iframe changes.
**Files to read first:** `apps/test-app/e2e/tests/field-types.spec.ts`, `packages/canopycms/src/editor/preview-bridge.tsx`

---

## Comments System

### 11. ⬜ Add a branch-level comment
**Spec file:** `comments.spec.ts`
**Scenario:** Create a branch. Open the branch manager or comments panel. Add a branch-level comment. Verify it appears in the comments list. Reload and verify persistence.
**Context:** Comments are stored in the branch clone. Look at `packages/canopycms/src/editor/CommentsPanel.tsx` and `BranchComments.tsx`. The comments panel may be opened via a button in the editor header or branch manager.
**data-testids needed:** Find or add testids for comment panel open button, comment textarea, comment submit button, comment list items.
**Files to read first:** `packages/canopycms/src/editor/CommentsPanel.tsx`, `packages/canopycms/src/editor/BranchComments.tsx`

### 12. ⬜ Add and resolve a field-level comment thread
**Spec file:** `comments.spec.ts`
**Scenario:** Select an entry and field. Trigger a field-level comment (look for a comment icon near the field or in the preview). Add a comment. Verify an inline comment thread appears (`InlineCommentThread.tsx`). Resolve/close the thread. Verify it is marked resolved.
**Files to read first:** `packages/canopycms/src/editor/InlineCommentThread.tsx`, `packages/canopycms/src/editor/EntryComments.tsx`, `packages/canopycms/src/editor/ThreadCarousel.tsx`

---

## Branch Workflow Extensions

### 13. ⬜ Approve a submitted branch (if UI exists)
**Spec file:** `branch-workflow.spec.ts` (add test)
**Scenario:** Check if there is an in-editor "Approve" action (separate from the GitHub PR flow). Look at `BranchManager.tsx` for approve button / reviewer approval UI. If it exists, test: create branch → submit → switch to reviewer user → approve → verify branch status changes.
**Context:** Current branch tests check that non-reviewers cannot see request-changes, but approval may go through GitHub only. Verify by reading `packages/canopycms/src/editor/BranchManager.tsx`.
**Files to read first:** `packages/canopycms/src/editor/BranchManager.tsx`, `apps/test-app/e2e/tests/branch-workflow.spec.ts`

### 14. ⬜ Branch switching preserves editor state
**Spec file:** `branch-workflow.spec.ts` (add test)
**Scenario:** Open branch A, edit an entry but do NOT save. Switch to branch B. Verify branch B loads correctly. Switch back to branch A. Verify the unsaved draft is preserved (or document expected behavior if it's discarded).
**Files to read first:** `apps/test-app/e2e/fixtures/branch-page.ts`, `packages/canopycms/src/editor/Editor.tsx`

---

## Entry Navigator

### 15. ⬜ Entry navigator — keyboard navigation
**Spec file:** `entry-navigator.spec.ts`
**Scenario:** Open the entry navigator. Use arrow keys to navigate between entries. Press Enter to select. Verify the form pane updates to the selected entry.
**Files to read first:** `packages/canopycms/src/editor/EntryNavigator.tsx`

### 16. ⬜ Entry navigator — search/filter
**Spec file:** `entry-navigator.spec.ts`
**Scenario:** If the entry navigator has a search/filter input, type a query. Verify the entry list filters. Clear the query and verify all entries return.
**Context:** Check `EntryNavigator.tsx` for a search input.
**Files to read first:** `packages/canopycms/src/editor/EntryNavigator.tsx`

---

## Error & Edge Cases

### 17. ⬜ Save failure shows error notification
**Spec file:** `error-handling.spec.ts`
**Scenario:** Intercept the save API call and force it to return a 500 error (use Playwright's `page.route()`). Make an edit and click save. Verify an error notification appears (Mantine notification with error styling).
**Context:** Notifications use Mantine's notification system. The selector `.mantine-Notification-root` already exists in fixtures.
**Files to read first:** `apps/test-app/e2e/fixtures/editor-page.ts`, `packages/canopycms/src/editor/Editor.tsx` (save error handling)

### 18. ⬜ Editor loads with no entries in collection
**Spec file:** `error-handling.spec.ts`
**Scenario:** Navigate to the editor with a collection that has no entries. Verify the UI handles this gracefully (empty state message, no crash). Optionally verify the "create entry" action is still available.
**Context:** May require creating a test collection with no entries or using the API to delete all entries from a test branch.
**Files to read first:** `packages/canopycms/src/editor/EntryNavigator.tsx`, `packages/canopycms/src/editor/Editor.tsx`

---

## Field Types (Unskip / New)

### 18. ⬜ Select (enum) field
**Spec file:** `field-types.spec.ts`
**Scenario:** Add a select field to the test app schema. Open the entry. Change the selected value. Save. Reload and verify persistence.
**data-testids needed:** Add `data-canopy-field` on the select in `packages/canopycms/src/editor/fields/SelectField.tsx`.
**Files to read first:** `packages/canopycms/src/editor/fields/SelectField.tsx`

### 19. ⬜ List field — add and remove items
**Spec file:** `field-types.spec.ts`
**Scenario:** The home schema has a `featuredPosts` list field. Open the home entry. Add a new list item. Verify it appears. Remove it. Save. Reload and verify the list state.
**data-testids needed:** Add `data-testid="list-add-item-{fieldName}"`, `data-testid="list-remove-item-{fieldName}-{index}"` to the list field component. Find the component at `packages/canopycms/src/editor/fields/` (look for list/array field).
**Files to read first:** `packages/canopycms/src/editor/fields/`, `packages/canopycms/src/editor/FormRenderer.tsx`

---

## Notes for Implementers

- Run existing tests first: `npx playwright test --project chromium` from repo root
- Check `playwright.config.ts` for config (timeout: 90s, workers: 1, base URL: `http://localhost:5174`)
- When adding `data-testid` attributes, add them to the component in `packages/canopycms/src/editor/` and reference them in the test
- The test app schema is at `apps/test-app/canopycms.config.ts` — adding fields there is acceptable for new field-type tests
- Keep tests sequential (no parallel) due to shared filesystem workspace
