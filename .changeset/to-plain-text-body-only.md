---
'canopycms': minor
---

### `toPlainText` takes an entry body and keeps prose after a leading `---` — **behaviour change**

<!-- migration
area: AI
action: Whole-file callers split first
row: toPlainText no longer strips front matter
-->

**What changed.** `toPlainText` from `canopycms/ai` no longer parses front matter. It used to,
so a body that opened with a `---` thematic break was read as the start of a front-matter block
and everything after it was dropped: `toPlainText('---\n\nA bio.\n')` returned `''`, so a
"has prose" check judged the entry empty and a search index got no text for it. A body whose
opening `---` was followed by lines that are not valid YAML made it throw. It now returns
`'A bio.'`, and never parses YAML. Front matter in the input is read as prose.

**To adopt.** Pass the value of the entry's body field, such as `entry.data.body` when the schema
names that field `body`. The content store has already split it from its front matter. A caller
holding a whole `.md`/`.mdx` file splits it first:

```ts
import matter from 'gray-matter'
import { toPlainText } from 'canopycms/ai'

const text = toPlainText(matter(file, {}).content)
```
