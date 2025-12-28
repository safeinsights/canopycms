# Developing CanopyCMS

This document contains development guidelines and patterns for contributors to CanopyCMS.

## Testing

### Running Tests

```bash
# Run all tests
npm test --workspaces

# Run tests for a specific package
cd packages/canopycms && npm test

# Run a specific test file
cd packages/canopycms && npx vitest run src/github-service.test.ts
```

### Expecting Console Messages

When testing code that intentionally logs to `console.error`, `console.warn`, or `console.log`, use the `mockConsole()` utility to:

1. Capture the messages for assertion
2. Prevent them from cluttering test output
3. Verify the expected message was logged

**Import the utility:**

```typescript
import { mockConsole } from './test-utils/console-spy.js'
```

**Basic usage:**

```typescript
it('logs error when something fails', () => {
  const consoleSpy = mockConsole()

  // Call code that logs to console
  doSomethingThatLogs()

  // Assert on specific messages
  expect(consoleSpy).toHaveErrored('Failed to do something')
  expect(consoleSpy).toHaveWarned('Deprecation warning')
  expect(consoleSpy).toHaveLogged('Debug info')

  // Always restore at the end
  consoleSpy.restore()
})
```

**Available matchers:**

- `toHaveErrored(pattern)` - matches `console.error` calls
- `toHaveWarned(pattern)` - matches `console.warn` calls
- `toHaveLogged(pattern)` - matches `console.log` calls

Patterns can be strings (substring match) or RegExp.

**Debugging captured messages:**

```typescript
const consoleSpy = mockConsole()
doSomething()
console.log('Captured:', consoleSpy.all()) // Shows all captured messages by method
consoleSpy.restore()
```

**Example from the codebase:**

```typescript
// From github-service.test.ts
it('should return null when token is missing', () => {
  const consoleSpy = mockConsole()
  const service = createGitHubService(mockConfig, 'https://github.com/owner/repo.git')
  expect(service).toBeNull()
  expect(consoleSpy).toHaveWarned('GitHub token not found')
  consoleSpy.restore()
})
```

This approach ensures:
- Expected console output doesn't pollute test runs
- Unexpected console output still surfaces (helping catch real issues)
- Console behavior is properly tested as part of the functionality
