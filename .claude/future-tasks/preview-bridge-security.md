# Preview Bridge `postMessage` Origin Validation

## Problem

`src/editor/preview-bridge.tsx` and `src/editor/hooks/useCommentSystem.ts` accept `message` events without validating `event.source` or `event.origin`. Any script running in the same browser session (another iframe, a browser extension, or an injected ad) can send a `canopycms:draft:update` message with arbitrary JSON and overwrite the active draft state.

**Affected handlers:**

- `usePreviewData` (`preview-bridge.tsx:72–89`) — updates live draft; no source check
- `usePreviewHighlight` (`preview-bridge.tsx:117–125`) — no source check
- `usePreviewFocusEmitter` (`preview-bridge.tsx:133–151`) — no source check
- Focus listener in `useCommentSystem` (`hooks/useCommentSystem.ts:227–264`) — no source check

The `handleReady` handler **does** check `event.source !== iframeRef.current.contentWindow` (correct); the others don't.

## Fix

### Editor-side listeners (accepting messages from preview iframe)

```ts
// Before registering the listener, store the iframe ref:
const previewFrameRef = useRef<HTMLIFrameElement | null>(null)

// In each handler:
window.addEventListener('message', (event) => {
  if (event.source !== previewFrameRef.current?.contentWindow) return
  // ... existing logic
})
```

### Iframe-side listeners (accepting messages from editor parent)

```ts
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  // ... existing logic
})
```

### Origin allowlist (defense-in-depth)

The preview can be same-origin or cross-origin (configured `previewUrl`). Store the expected origin from the config:

```ts
const expectedOrigin = new URL(previewUrl).origin // or '*' if same-origin only

if (event.origin !== expectedOrigin && event.origin !== window.location.origin) return
```

## Design Questions

1. Can the preview iframe ever be cross-origin? If so, we need to communicate the expected origin to the iframe side.
2. Should we add message signing (hmac) for defense against compromised preview iframes? Probably overkill for v1.
3. The `useCommentSystem` focus listener references a `previewFrame` — confirm it has access to the iframe ref.

## Priority

Medium-High. Requires a malicious co-hosted script to exploit, but the attack is trivial to execute and the impact is silent draft corruption.

## Files

- `packages/canopycms/src/editor/preview-bridge.tsx`
- `packages/canopycms/src/editor/hooks/useCommentSystem.ts`
- `packages/canopycms/src/editor/Editor.tsx` (passes iframe ref down to bridge)

## Related

- Review report: HIGH-6 (preview bridge event.source)
