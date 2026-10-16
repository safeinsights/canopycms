---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/preview-highlight-focus-regression`, base `int-202610-b`. The highlight toggle "stopped outlining" and click-to-focus "stopped focusing" were not a bridge regression: both worked end to end in example1 (`createPreviewPage`) and test-app (hook-only) at int head. An adopter's preview views mark no element with `fieldProps`, so there both had nothing to act on, silently, and the README never said marks are required. Fixed by saying so: while highlighting is on the preview reports its mark count (`canopycms:preview:marks`), and at 0 the toggle shows a note. The icon did regress: tabler's `IconSquareDashed` draws a solid square, now `IconMarquee`. Also fixed: clicking a list item or block (`tags[1]`, `blocks[2]`) focused nothing; it now focuses the nearest marked ancestor, and each block card is marked.
---

# The preview highlight toggle and click-to-focus do nothing on a page that marks nothing

**Status: RESOLVED 2026-10-09**, branch `fix/preview-highlight-focus-regression`, base
`int-202610-b`.

## What was seen

In the editor, on a recent int build, the sidebar's highlight toggle outlined nothing,
clicking a preview element did not focus its field, and the toggle's icon was a plain
square where a dashed one was remembered.

## What was found

- **No bridge regression.** Driven in a browser at int head, the toggle outlined every
  `[data-canopy-path]` element and kept doing so across an entry switch, and a real click
  scrolled to and highlighted the field, nested block fields included, on example1's
  `createPreviewPage` route and on test-app's hook-only page. `usePreviewHighlight` and
  `usePreviewFocusEmitter` still run inside `withCanopyPreview`, ahead of the hydration gate.
- **The adopter's views carry no marks.** None of its preview views calls `fieldProps`, in
  any commit, so the highlight style matched nothing and clicks found no marked ancestor.
  Nothing told the author: the README's Live Preview section promised click-to-focus without
  saying the elements must be marked, and the editor gave no signal.
- **The icon did regress.** The July 2026 icon migration replaced lucide's dashed
  `LuSquareDashed` with tabler's `IconSquareDashed`, which in `@tabler/icons-react`
  3.41–3.46 is a single solid rounded-square path, the same shape as `IconSquare`.
- **List items and blocks never focused.** A view can mark `tags[1]` or `blocks[2]`, but the
  editor renders no field with that path, so the click was a silent no-op.

## What shipped

- The toggle uses `IconMarquee`, a dashed rounded square.
- `findFieldTarget` in `useCommentSystem.ts` falls back to the nearest marked ancestor path,
  and `BlockField` marks each block card with its own path.
- While highlighting is on, the preview reports `{ type: 'canopycms:preview:marks', count }`,
  and again (throttled) whenever a MutationObserver sees the count change; `PreviewFrame`
  passes it up, and at 0 the toggle shows a note naming `fieldProps`. A bridge that sends no
  count reads as unknown and shows nothing; a toggle clears the last count.
- README Live Preview states that both features act on elements marked with `fieldProps`.
- `preview-highlight-focus.spec.ts` covers both preview shapes; test-app now frames posts
  through its `createPreviewPage` route.
