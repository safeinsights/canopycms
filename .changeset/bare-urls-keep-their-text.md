---
'canopycms': patch
---

### Bare URLs in a markdown body survive a save

<!-- migration
area: Editing
action: None
row: Unedited bare URLs saved byte for byte
-->

**What changed.** The rich-text editor reads a bare URL (`www.example.org`, `https://example.org`
or an email address) as GFM does. Opening an entry no longer marks it modified, and saving a
frontmatter change keeps the body byte for byte. Before, every bare URL was rewritten as an
explicit link, and a sentence's period went into the href (`[www.example.org.](https://www.example.org.)`).
A bare URL typed or edited in the editor is saved as typed, so the trailing punctuation GFM
leaves out of a link (`.`, `,`, `:`, `;`, `!`, `?`, `*`, `_`, `~`, an unbalanced `)`) stays out
of it. A bare URL given a label becomes an explicit link.
