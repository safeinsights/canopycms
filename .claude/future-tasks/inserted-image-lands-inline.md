# [P3] An image inserted from the toolbar lands inside the paragraph at the cursor

Found 2026-10-08 in the adopter's report for request 85 (an e2e test PR's bot commit).

## The gap

Inserting an image with the body editor's toolbar puts it inline at the cursor, with no blank lines
around it: `…proportions, ![alt](/assets/…)colors, or…` and `…org.![alt](/assets/…)`. That is valid
markdown and may be exactly where the cursor was, but an editor adding a figure almost always means
a block of its own, and the inline result renders glued to the surrounding text.

## Proposal

Check what MDXEditor's image dialog does with a collapsed selection mid-paragraph. If the insert can
be made block-level (split the paragraph, or insert after it) from `MdxImageDialog`'s save, do that
for the toolbar path and keep drag-and-drop inline; otherwise document the behaviour for editors.
