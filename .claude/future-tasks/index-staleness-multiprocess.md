# Index Staleness and Multi-Process Consistency

## Problem

The `ContentIdIndex` maintains an in-memory mapping of content IDs to file paths. In multi-process environments (multiple Lambda instances, concurrent editors), the index can become stale when:

1. **Another process writes a new file**: Current process's index misses the new ID until rebuild
2. **Slug changes cause file renames**: Old file remains on disk when `write()` creates a new file with different ID
3. **Direct file deletions**: Files deleted outside `ContentStore.delete()` (e.g., git operations) leave stale entries in index
4. **Race conditions**: Multiple processes creating entries simultaneously with unique IDs

Current behavior: Eventual consistency - processes continue with stale index until they happen to rebuild it.

## Impact

- **Severity**: Low for human editors (single concurrent edit rare)
- **Risk**: Medium for automated systems or bulk operations
- **User experience**: Entries might temporarily "disappear" until index rebuilds

## Related Code

- [content-id-index.ts:39-42](packages/canopycms/src/content-id-index.ts#L39-L42) - Documents the issue
- [content-store.ts:356-422](packages/canopycms/src/content-store.ts#L356-L422) - `write()` doesn't clean up old files
- [content-store.ts:68-74](packages/canopycms/src/content-store.ts#L68-L74) - Lazy index loading

## Proposed Solutions

### Option 1: Automatic Rebuild on Miss (Defensive)

Add fallback logic when expected IDs aren't found:

```typescript
async findById(id: string): Promise<IdLocation | null> {
  let location = this.idToLocation.get(id)

  // If not found, try rebuilding index once
  if (!location && !this.hasRebuiltOnce) {
    await this.buildFromFilenames('content')
    this.hasRebuiltOnce = true
    location = this.idToLocation.get(id)
  }

  return location || null
}
```

**Pros**: Self-healing, no adopter changes needed
**Cons**: Performance hit on first miss, could mask bugs

### Option 2: Filesystem Watcher for Index Updates

Use `chokidar` (already a dependency) to watch for file changes and incrementally update the index:

```typescript
private watcher?: FSWatcher

async startWatching(): Promise<void> {
  this.watcher = chokidar.watch(this.root, {
    ignored: /(^|[\/\\])\.|_ids_/,
    persistent: true
  })

  this.watcher
    .on('add', (path) => this.handleFileAdded(path))
    .on('unlink', (path) => this.handleFileDeleted(path))
    .on('rename', (oldPath, newPath) => this.handleFileRenamed(oldPath, newPath))
}
```

**Pros**: Real-time updates, efficient
**Cons**: Complexity, needs lifecycle management, might not work across processes on same filesystem

### Option 3: Cleanup Old Files on Slug Change

In `ContentStore.write()`, detect if the entry exists with a different path and delete the old file:

```typescript
async write(collectionPath: string, slug: string, input: WriteInput): Promise<ContentDocument> {
  // ... existing code ...

  if (id) {
    const existing = idIndex.findById(id)
    if (existing && existing.relativePath !== relativePath) {
      // Slug changed - delete old file
      const oldAbsolutePath = path.join(this.root, existing.relativePath)
      await fs.unlink(oldAbsolutePath).catch(() => {
        // Ignore if already deleted
      })
    }
  }

  // ... write new file and update index ...
}
```

**Pros**: Prevents orphaned files
**Cons**: Could be surprising if user expects old file to remain

### Option 4: Index Validation on Startup

Add a method to check if indexed files still exist and remove stale entries:

```typescript
async validateIndex(): Promise<{ removed: number; errors: string[] }> {
  const removed: string[] = []
  const errors: string[] = []

  for (const [id, location] of this.idToLocation) {
    const absolutePath = path.join(this.root, location.relativePath)
    try {
      await fs.access(absolutePath)
    } catch {
      // File doesn't exist - remove from index
      this.remove(id)
      removed.push(id)
    }
  }

  return { removed: removed.length, errors }
}
```

**Pros**: Simple, catches deletions from any source
**Cons**: I/O cost, doesn't help with missing entries (only removes stale ones)

## Recommended Approach

Combine **Option 3** (cleanup on slug change) and **Option 4** (validation on startup):

1. **Short-term**: Implement Option 3 to prevent orphaned files during normal operations
2. **Medium-term**: Add Option 4 and call it during `idIndex()` initialization in prod mode
3. **Long-term**: Consider Option 1 as a defensive fallback if issues persist

## Implementation Checklist

- [ ] Add cleanup logic in `ContentStore.write()` to detect and remove old files on slug change
- [ ] Add `validateIndex()` method to `ContentIdIndex`
- [ ] Call `validateIndex()` during lazy index load in prod mode (not dev, to avoid thrashing)
- [ ] Add tests for slug change scenarios
- [ ] Add tests for validation with missing files
- [ ] Add telemetry/logging when stale entries are found
- [ ] Document the behavior in adopter guide

## Testing Strategy

1. **Unit tests**: Test slug change cleanup and validation separately
2. **Integration tests**: Simulate multi-process scenarios:
   - Two ContentStore instances pointing to same filesystem
   - One writes, other reads immediately
   - Verify eventual consistency behavior
3. **Manual testing**: Test with actual EFS in AWS Lambda environment

## Telemetry/Monitoring

Add metrics to track:

- Index rebuild frequency
- Stale entries removed during validation
- Time spent in validation
- Cache hit/miss ratio for findById lookups

This helps understand if the issue becomes a real problem in production.
