# Fix Failing Playwright E2E Tests for CanopyCMS

## Background

I have a comprehensive Playwright E2E test suite for CanopyCMS with **10 passing tests** and **11 failing tests**. The test infrastructure is solid - the failures are revealing real implementation issues that need investigation and fixing.

## Current Status

**Test Results:** 10 passing / 11 failing out of 21 total tests

**Passing Tests:**

- Editor loads with form and preview panes
- Entry navigator functionality
- Branch creation with metadata and validation
- Permission boundaries validation
- Multiple field editing scenarios
- Large content handling
- Rapid successive edits
- Field edit and preview updates

**Failing Tests (need investigation):**

1. **Branch Lifecycle & Workflow Suite** (6 failures):
   - `complete happy path: create → edit → submit → approve → archive`
   - `submit and withdraw flow`
   - `request changes flow`
   - `permission boundaries: non-reviewers cannot approve`
   - `branch deletion permissions`
   - `branch list filtering and status display`

2. **Multi-Field Content Editing Suite** (4 failures):
   - `text field: basic input and persistence`
   - `textarea/MDX field: multi-line content`
   - `list field: add/remove items`
   - `special characters and unicode`

3. **Editor Happy Path Suite** (1 failure):
   - `complete edit workflow: load → select → edit → save → verify`

## How to Run the Tests

```bash
# Run all tests
npm run test:e2e

# Run specific test suite
npx playwright test apps/test-app/e2e/tests/branch-workflow.spec.ts

# Run specific test by grep pattern
npx playwright test -g "complete happy path"

# Run with UI mode for debugging (RECOMMENDED)
npx playwright test --ui

# Run with debug mode (step through tests)
npx playwright test --debug

# Run specific test in headed mode (see browser)
npx playwright test --headed -g "text field: basic input"

# Generate and view HTML report
npx playwright show-report
```

## Known Issues from Last Run

### 1. Save Notifications Not Appearing

**Error:** `expect(locator).toBeVisible() failed - Locator: .mantine-Notification-root (hasText: 'Saved')`

**Affected Tests:**

- Multiple field-types tests
- Editor happy path test

**Possible Causes:**

- Save operations failing silently
- Validation errors preventing save
- Notification timing/duration too short
- Wrong selector or notification text

**Investigation Steps:**

1. Run test with `--headed` flag to see browser
2. Check browser console for errors
3. Look at network tab for failed save requests
4. Check if validation errors are appearing
5. Verify notification appears at all (maybe different text?)

### 2. Submit API Returning False

**Error:** `expect(submitResponse.ok).toBe(true)` failing

**Affected Tests:**

- `request changes flow`
- `permission boundaries: non-reviewers cannot approve`
- `branch list filtering and status display`

**Possible Causes:**

- Endpoint `/api/canopycms/:branch/workflow/submit` not fully implemented
- Missing GitHub integration for PR creation
- Validation failing (branch must have changes to submit?)
- Authentication/authorization issue

**Investigation Steps:**

1. Check API response status and body: `console.log(submitResponse.status, await submitResponse.text())`
2. Look at API route implementation at `apps/test-app/app/api/canopycms/[[...canopycms]]/route.ts`
3. Check if endpoint exists and what it returns
4. Verify branch has changes before submitting

### 3. Submit Button Disabled

**Error:** `Submit button for branch X is disabled. The branch may not be in 'editing' status or user may not be the creator.`

**Affected Tests:**

- `branch deletion permissions`

**Possible Causes:**

- Branch status not being tracked correctly
- User context (createdBy) not matching current user
- Branch permissions not set up correctly
- Race condition in branch creation/status update

**Investigation Steps:**

1. Add debug logging to see branch status and user context
2. Check BranchManager component permissions logic
3. Verify API returns correct `createdBy` field
4. Add longer waits after branch creation

### 4. Branch Status Not Updating

**Affected Tests:**

- Various workflow tests

**Possible Causes:**

- API changes not persisted to disk/database
- UI state not refreshing after API calls
- Status transition logic incorrect
- Missing state synchronization

**Investigation Steps:**

1. Check if status changes are saved to branch metadata
2. Verify UI polls/refreshes after status changes
3. Add page reload after API operations
4. Check branch status in filesystem

## Your Task

Please investigate and fix the failing tests by:

### Step 1: Run Individual Failing Tests

```bash
# Start with the simplest failure
npx playwright test --headed -g "text field: basic input and persistence"

# Then tackle workflow issues
npx playwright test --headed -g "submit and withdraw flow"
```

### Step 2: Investigate Root Causes

For each failure, determine if it's due to:

- ❌ **Missing API endpoint implementations** → Implement the endpoint
- ❌ **Incorrect test assumptions** → Adjust the test
- ❌ **Timing/race conditions** → Add proper waits/retries
- ❌ **Validation errors** → Fix validation or test data
- ❌ **State synchronization issues** → Add state refresh logic
- ❌ **Authentication/authorization problems** → Fix auth context

### Step 3: Fix the Issues

**If it's an app bug:**

- Fix the implementation in the app code
- Verify the fix with unit or integration (src/**integration**) tests
- Verify the fix with the playwright test
- Document what was wrong

**If it's a test issue:**

- Adjust test expectations or setup
- Add better error handling
- Add debug logging for future debugging

### Step 4: Verify Fixes

```bash
# Run all tests
npm run test:e2e

# Goal: All 21 tests passing ✅
```

## Test File Locations

### Test Suites

- [apps/test-app/e2e/tests/branch-workflow.spec.ts](apps/test-app/e2e/tests/branch-workflow.spec.ts) - Branch lifecycle tests
- [apps/test-app/e2e/tests/field-types.spec.ts](apps/test-app/e2e/tests/field-types.spec.ts) - Multi-field editing tests
- [apps/test-app/e2e/tests/editor-happy-path.spec.ts](apps/test-app/e2e/tests/editor-happy-path.spec.ts) - Basic editor tests

### Fixtures

- [apps/test-app/e2e/fixtures/branch-page.ts](apps/test-app/e2e/fixtures/branch-page.ts) - Branch Page Object
- [apps/test-app/e2e/fixtures/editor-page.ts](apps/test-app/e2e/fixtures/editor-page.ts) - Editor Page Object
- [apps/test-app/e2e/fixtures/test-workspace.ts](apps/test-app/e2e/fixtures/test-workspace.ts) - API helpers
- [apps/test-app/e2e/fixtures/test-users.ts](apps/test-app/e2e/fixtures/test-users.ts) - User switching

### Application Code to Check

- `apps/test-app/app/api/canopycms/[[...canopycms]]/route.ts` - API route handler
- `packages/canopycms/src/editor/BranchManager.tsx` - Branch UI component
- `packages/canopycms/src/editor/components/EditorHeader.tsx` - Editor header
- `apps/test-app/app/lib/canopy.ts` - Mock auth configuration

## Debugging Tips

### 1. Use Playwright UI Mode

```bash
npx playwright test --ui
```

- Best for interactive debugging
- See test steps in real-time
- Inspect DOM and network requests
- Time-travel through test execution

### 2. Add Debug Logging

```typescript
// In test
console.log('Branch status:', await branchPage.getBranchStatus(branchName))
console.log('Submit response:', await submitResponse.text())

// In fixture
console.log('Button state:', {
  visible: await button.isVisible(),
  enabled: await button.isEnabled(),
  disabled: await button.isDisabled(),
})
```

### 3. Check Screenshots

Failed tests automatically capture screenshots in `test-results/` directory. Look at them!

### 4. Inspect Network Requests

```typescript
// In test
page.on('response', (response) => {
  if (response.url().includes('/api/canopycms/')) {
    console.log(`${response.status()} ${response.url()}`)
  }
})
```

### 5. Use Debugger

```typescript
// Add this line to pause test execution
await page.pause()
```

## Test Infrastructure Context

### Authentication System

- **Mock auth** configured for E2E tests
- **Test users:** admin, editor, viewer, reviewer
- **User switching:** Set `X-Test-User` header (handled by `switchUser()` function)
- **User IDs:**
  - `test-admin` → Groups: ['Admins']
  - `test-editor` → Groups: ['Editors']
  - `test-viewer` → Groups: []
  - `test-reviewer` → Groups: ['Reviewers']

### Branch Workflow

- Tests run on **Next.js App Router** application
- Branch workflow integrates with GitHub PR system (may be mocked)
- Branches stored in `.canopycms/branches/` directory
- Tests use **local-prod-sim mode** (not local-simple)

### Test Execution

- Tests run **sequentially** (`fullyParallel: false`) due to shared workspace
- Each test resets workspace with `resetWorkspace()` before running
- Tests verify both UI interactions AND file system changes
- Page Object Model used throughout for maintainability

## Expected Outcome

**All 21 tests should pass.**

The test infrastructure is solid and well-designed. Focus on finding and fixing the actual bugs in the application code that the tests are revealing. These are real issues that would affect users!

## Success Criteria

- ✅ All 21 Playwright tests passing
- ✅ No flaky tests (should pass consistently)
- ✅ Tests complete in under 3 minutes
- ✅ Clear error messages when tests fail
- ✅ Application bugs identified and documented

---

## Quick Start

```bash
# 1. Run tests to see current failures
npm run test:e2e

# 2. Pick one failing test and run with UI
npx playwright test --ui -g "text field: basic input"

# 3. Investigate the failure using browser DevTools

# 4. Fix the bug in app code or adjust test

# 5. Re-run to verify
npx playwright test -g "text field: basic input"

# 6. Repeat for remaining failures

# 7. Final verification
npm run test:e2e
```

Good luck! The tests are excellent quality - they'll guide you to the real issues. 🚀
