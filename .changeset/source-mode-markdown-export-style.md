---
'canopycms': patch
---

### Markdown typed in "Edit source" saves in the export style

<!-- migration
area: Editing
action: None
row: Source-mode markdown saves in Prettier's markers
-->

**What changed.** A markdown body typed in a markdown field's "Edit source" mode was written as
typed, so `*italic*` and `*` bullets failed a required `prettier --check`. A save now
re-serialises every new or edited block in the rich editor's export style (`-` bullets, `_`
emphasis, `**` strong, `---` rules, no needless escapes such as `a\_b`), whichever mode produced
it, and so does a new entry's body. Untouched blocks keep their bytes, and the save still writes
only text that parses to exactly what the editor sent.
