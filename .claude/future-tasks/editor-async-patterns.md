# Editor Async Patterns: Cancellation & Stale Response Prevention

## Problem

Several editor hooks fire async requests but don't cancel or ignore responses when the relevant context changes (entry navigation, branch switch, unmount). This causes:

1. **Stale response overwrites**: response from request A lands after request B was started; A's data overwrites B's
2. **Post-unmount state updates**: component unmounts but a pending promise calls setState, producing React warnings and potentially incorrect state on remount
3. **Continuous refetching**: dep arrays include object references (arrays) instead of derived keys, causing API calls on every render

### Affected code

#### `ReferenceField.tsx` (HIGH)

`packages/canopycms/src/editor/fields/ReferenceField.tsx:73–101`

Effect deps include `collections` and `entryTypes` arrays. If the parent recreates these arrays on each render (e.g., from `normalizeOptions`), the effect fires on every keystroke. No cancellation: old promises overwrite newer fetch results.

**Fix:** Use a stable `fetchKey = [collections?.join(','), entryTypes?.join(','), branch].join('|')` as the sole dep. Add an `active` flag or `AbortController`:

```ts
useEffect(() => {
  let active = true
  fetchReferenceOptions().then((data) => {
    if (active) setOptions(data)
  })
  return () => {
    active = false
  }
}, [fetchKey])
```

#### `useReferenceResolution.ts` (HIGH)

`packages/canopycms/src/editor/hooks/useReferenceResolution.ts:155–217`

Debounce clears the timeout but if the fetch inside the timeout has already started, the pending `resolveChangedReferences` still calls `resolvedCache.current.set()` and `setResolutionTrigger()` after unmount or after a newer request started.

**Fix:** Track a generation counter. Increment on each new request. In the async callback, check `if (gen !== currentGen.current) return`.

#### `useEntryManager` load effect (MEDIUM)

`packages/canopycms/src/editor/Editor.tsx:347–372` and `packages/canopycms/src/editor/hooks/useEntryManager.ts:125–137`

`loadEntry(A)` starts; user selects B; `loadEntry(B)` starts. A's `setEntriesLoading(false)` can clear the spinner while B is still loading. A's error notification surfaces to a user who has moved on.

**Fix:** Ref-track the `currentContentId` at time of dispatch. On resolution, skip `setEntriesLoading(false)` and notifications if `currentContentId` has changed.

#### `refreshEntries` branch change (MEDIUM)

`packages/canopycms/src/editor/hooks/useEntryManager.ts:323–340`

Rapid branch switches overlap `refreshEntries` calls. Whichever resolves last wins. Fix with the same generation-counter approach.

## Design Notes

- Use a simple `let active = true` / `return () => { active = false }` pattern for single-use effects
- Use a `useRef<number>` generation counter for effects that fire repeatedly (reference resolution)
- Consider a `useAsyncEffect` utility that wraps the cancellation boilerplate (could live in `utils/`)
- `AbortController` is the right choice for fetch-based cancellation once the API client accepts `signal`

## Priority

Medium-High. Likely to be noticed as flickering in the reference field or as stale preview data after fast navigation.

## Files

- `packages/canopycms/src/editor/fields/ReferenceField.tsx`
- `packages/canopycms/src/editor/hooks/useReferenceResolution.ts`
- `packages/canopycms/src/editor/hooks/useEntryManager.ts`
- `packages/canopycms/src/editor/Editor.tsx`

## Related

- Review report: HIGH-9, HIGH-10, MEDIUM (loadEntry, refreshEntries)
