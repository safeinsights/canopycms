---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-10. On a deployed editor, one cold first load in eight left `PreviewFrame` waiting even though the preview's ready message reached the editor window with the right origin and source. The "Live updates off" chip and Retry now cover it, but the cause is unexplained and was not reproduced again
---
# Preview ready message delivered but not handled on a cold first load

`PreviewFrame` clears its progress bar when the preview's `canopycms:preview:ready` arrives. If
none arrives within 5s of the iframe's `load`, it shows "Live updates off" with a Retry that
remounts the iframe. That covers the symptom. This task is the cause.

## What was measured

These loads were captured read-only on a deployed adopter editor (canopycms `0.0.68-int.111`),
using a capture-phase `message` listener in the editor window:

- **Every load got exactly one ready message.** Its origin was the editor's and its `source` was
  the iframe's `contentWindow`. The preview is same-origin and lives under the editor's path, with
  no redirect.
- **The stuck load was the first, cold-cache one.** The iframe document started 6.5s into the
  editor's life, and ready arrived 5.2s later (slow hydration). The iframe's `load` came 1.2s after
  ready. React state still read `syncPending: true`, and the iframe document was never replaced
  (one `timeOrigin`), so no `src` change re-armed the bar.
- **A manual `location.reload()` of the iframe cleared the bar at once**, so the handler was
  attached by then.
- **No other load reproduced it (0 of 7).** That covers warm full reloads, loads in a hidden tab,
  a popup, and an entry switch (where the frame remounts).

## What is left to rule out

- Whether `PreviewFrame`'s message effect had attached when ready arrived. Wrapping
  `window.addEventListener` to log it broke the host's auth provider, so that question is still
  open. A `performance.mark` inside the effect, shipped in a debug build, would answer it.
- Whether `Editor.tsx` mounts `PreviewFrame` (gated on `previewFrameData`) and then re-renders it
  in a way that loses the update on a slow first load.
