---
'canopycms': patch
---

### Markdown typed in "Edit source" saves in Prettier's markers

<!-- migration
area: Editing
action: None
row: Source-mode markdown saves in Prettier's markers
-->

**What changed.** A markdown body typed in a markdown field's "Edit source" mode used to be written as typed, so `*italic*` and `*` bullets failed a required `prettier --check`. A save now restyles every new or edited block in place to Prettier's style: `-` bullets, `_` emphasis, `**` strong, `---` rules, `#` headings, backtick fences, padded tables, and one blank line between blocks. This applies whichever editor mode produced the block, and to a new entry's body. Only markers and whitespace change, plus an escaped `_` between two letters, which Prettier also unescapes. Text, links, entities and other escapes stay as typed. Untouched blocks keep their bytes, and a block is restyled only if it still means exactly what was typed. Cases Prettier still flags are listed in [#1116](https://github.com/safeinsights/canopycms/issues/1116).
