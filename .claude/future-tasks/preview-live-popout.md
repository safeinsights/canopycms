---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, parked by the editor UI/UX epic. "Open in new tab" can only show the last saved version, because `usePreviewData` refuses drafts unless framed by the editor (`window.parent === window` returns early). A live pop-out would bridge drafts over `window.opener` with origin pinning, and needs a security review first
---
# Live preview in a popped-out window

The epic ([ui-epic-202610.md](ui-epic-202610.md), preview toolbar) ships "Open saved version" and
an in-place Maximize. A live pop-out is the follow-up:

- The preview bridge's framing check is a security boundary: a standalone page, including one
  opened by `window.open` from a hostile site, must never accept drafts.
- A pop-out would accept messages only from `window.opener`, with the opener's origin pinned
  exactly as `isTrustedEditorMessage` pins the parent's, and the editor would post to the popup
  window the way it posts to the iframe.
- Needs: a threat model of opener-based messaging (opener navigation, `noopener` defaults),
  tests that a non-editor opener is refused, and a decision on whether both previews run at once.
