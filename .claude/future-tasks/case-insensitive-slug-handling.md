## Bug: Case-insensitive slug handling in content read path

### Problem

Canopy has a case mismatch between slug validation and file lookup that makes it impossible to read entries with Title-Case filenames (e.g., `doc.Onboarding-Checklist.3TfCdUdsbfb7.mdx`) through the `read()` API.

**The chain of failure:**

1. `context.ts:95` — `parseSlug()` validates that slugs are lowercase-only via `/^[a-z0-9][a-z0-9-]*$/` (line 381 of `paths/validation.ts`). This means callers MUST pass lowercase slugs.
2. `content-store.ts:233-234` — `buildPaths()` scans the collection directory and compares `extractSlugFromFilename(entry.name)` against the (now-lowercase) slug using strict equality (`===`).
3. `extractSlugFromFilename` (in `content-id-index.ts:441`) preserves the original case from the physical filename — so for `doc.Onboarding-Checklist.3TfCdUdsbfb7.mdx` it returns `Onboarding-Checklist`.
4. `'Onboarding-Checklist' === 'onboarding-checklist'` → **false** → file not found.

**Result:** Any entry whose filename has uppercase characters in the slug portion cannot be read through `canopy.read()`. The slug validator forces lowercase input, but the file lookup requires the original case to match. These two invariants contradict each other.

### Fix (bug)

In `content-store.ts`, the file lookup comparison in `buildPaths()` (around line 234) should be case-insensitive:

```typescript
return existingSlug.toLowerCase() === safeSlug.toLowerCase()
```

This is the minimal fix — `parseSlug` already normalizes input to lowercase, so the only mismatch is on the filename side.

### Related: `buildContentTree` logical paths preserve filename case

`buildContentTree()` produces `ContentTreeNode.path` values that preserve the original case from filenames. For example, entry `doc.Onboarding-Checklist.3TfCdUdsbfb7.mdx` produces a logical path containing `Onboarding-Checklist`.

Consumers that build URLs from these paths (e.g., via the `buildPath` callback) get mixed-case URLs that don't match the lowercase slugs required by `read()`. Currently the docs-site works around this by lowercasing in the `buildPath` callback, but it would be more consistent if `buildContentTree` normalized entry slugs to lowercase in the logical paths it produces — matching the invariant that `parseSlug` enforces.

This is a nice-to-have since consumers can work around it, but it would prevent the mismatch from surprising future integrations.
