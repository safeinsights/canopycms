import { format } from 'prettier'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { serializeFrontmatter } from './content-serialize'
import { preserveMarkdownSource } from './markdown-body-splice'

// Lets one test make every parse after the first two (the original and the edit) read back as
// an empty document, so the splice's own self-check is what fails.
const parseControl = vi.hoisted(() => ({ corruptAfter: Infinity, calls: 0 }))
vi.mock('mdast-util-from-markdown', async (importActual) => {
  const actual = await importActual<typeof import('mdast-util-from-markdown')>()
  return {
    ...actual,
    fromMarkdown: (...args: Parameters<typeof actual.fromMarkdown>) => {
      parseControl.calls++
      return parseControl.calls > parseControl.corruptAfter
        ? actual.fromMarkdown('')
        : actual.fromMarkdown(...args)
    },
  }
})

afterEach(() => {
  parseControl.corruptAfter = Infinity
  parseControl.calls = 0
})

/** A Prettier-formatted body as gray-matter splits it: led by the blank line after `---`. */
const BODY = `
## Overview

A paragraph with _emphasis_, **strong** and \`code\`. Escapes stay as written: a_b.

- First item
- Second item with **bold**
  - Nested child
  - Another child
- Third item

1. One
2. Two
3. Three

> A quote.

\`\`\`sh
echo hello
\`\`\`

| Name  | Value |
| ----- | ----: |
| alpha |     1 |
| beta  |    22 |

---

Closing paragraph.
`

/**
 * BODY as the rich editor sends it back untouched, in MDXEditor's default style: `*` bullets
 * and emphasis, `***` rules, escaped underscores, and no surrounding blank lines. Untouched
 * blocks must survive whatever style the editor writes, so the tests use the most different one.
 */
const EXPORT = `## Overview

A paragraph with *emphasis*, **strong** and \`code\`. Escapes stay as written: a\\_b.

* First item
* Second item with **bold**
  * Nested child
  * Another child
* Third item

1. One
2. Two
3. Three

> A quote.

\`\`\`sh
echo hello
\`\`\`

| Name  | Value |
| ----- | ----: |
| alpha |     1 |
| beta  |    22 |

***

Closing paragraph.`

/** `text` with `from` replaced exactly once; throws if `from` is absent or repeated. */
function edit(text: string, from: string, to: string): string {
  const at = text.indexOf(from)
  if (at === -1 || text.indexOf(from, at + 1) !== -1) throw new Error(`not exactly once: ${from}`)
  return text.slice(0, at) + to + text.slice(at + from.length)
}

describe('preserveMarkdownSource', () => {
  it('returns the body byte-for-byte when the editor re-serialised it without an edit', () => {
    expect(preserveMarkdownSource(BODY, EXPORT, 'md')).toBe(BODY)
  })

  it('writes an image appended at the end as the only change', () => {
    const updated = `${EXPORT}\n\n![Logo](/assets/logo.png)`
    expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
      edit(BODY, 'Closing paragraph.\n', 'Closing paragraph.\n\n![Logo](/assets/logo.png)\n'),
    )
  })

  it('writes an image inserted mid-paragraph as a change to that paragraph only', () => {
    const updated = edit(EXPORT, 'Closing paragraph.', 'Closing ![Logo](/l.png)paragraph.')
    expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
      edit(BODY, 'Closing paragraph.', 'Closing ![Logo](/l.png)paragraph.'),
    )
  })

  it('writes an edited paragraph in the editor text, and nothing else', () => {
    const line =
      'A paragraph with *emphasis*, **strong**, edited, and `code`. Escapes stay as written: a\\_b.'
    const updated = edit(EXPORT, EXPORT.split('\n')[2] ?? '', line)
    expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
      edit(BODY, BODY.split('\n')[3] ?? '', line),
    )
  })

  it('keeps a list edit local when the same save inserts a block beside it', () => {
    const updated = edit(EXPORT, '* Third item\n', '* Third item\n* New item\n\nInserted.\n')
    expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
      edit(BODY, '- Third item\n', '- Third item\n- New item\n\nInserted.\n'),
    )
  })

  it('writes a moved block from its own source text', () => {
    // The paragraph the editor writes differently (`*emphasis*`, `a\\_b`), moved to the end.
    const exported = EXPORT.split('\n')[2] ?? ''
    const original = BODY.split('\n')[3] ?? ''
    const updated = `${edit(EXPORT, `${exported}\n\n`, '')}\n\n${exported}`
    expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
      `${edit(BODY, `${original}\n\n`, '')}\n${original}\n`,
    )
  })

  describe('list items', () => {
    const SECOND = '* Second item with **bold**\n  * Nested child\n  * Another child\n'

    it('keeps the original items when the list is reordered', () => {
      const updated = edit(
        EXPORT,
        `* First item\n${SECOND}* Third item`,
        `* Third item\n${SECOND}* First item`,
      )
      const second = SECOND.replaceAll('* ', '- ')
      expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
        edit(BODY, `- First item\n${second}- Third item`, `- Third item\n${second}- First item`),
      )
    })

    it('removes only a deleted item', () => {
      const updated = edit(EXPORT, '* First item\n', '')
      expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(edit(BODY, '- First item\n', ''))
    })

    it("writes an inserted item with the list's own marker", () => {
      const updated = edit(EXPORT, '* Third item', '* Third item\n* New item')
      expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
        edit(BODY, '- Third item', '- Third item\n- New item'),
      )
    })

    it('changes only the line of an edited nested item', () => {
      const updated = edit(EXPORT, '  * Nested child', '  * Nested child, edited')
      expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
        edit(BODY, '  - Nested child', '  - Nested child, edited'),
      )
    })

    it('numbers an inserted ordered item the way the list on disk counts', () => {
      const updated = edit(
        EXPORT,
        '1. One\n2. Two\n3. Three',
        '1. One\n2. Inserted\n3. Two\n4. Three',
      )
      expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(
        edit(BODY, '1. One\n2. Two\n3. Three', '1. One\n2. Inserted\n3. Two\n4. Three'),
      )
    })

    it('keeps an all-ones ordered list all ones', () => {
      const body = '\n1. One\n1. Two\n'
      expect(preserveMarkdownSource(body, '1. One\n2. Two\n3. Three', 'md')).toBe(
        '\n1. One\n1. Two\n1. Three\n',
      )
    })

    it('writes the whole list as the editor sent it when an item splice would change its looseness', () => {
      const body = '\n- a\n\n- b\n\nAfter.\n'
      const updated = '* a\n* b\n* c\n\nAfter.'
      expect(preserveMarkdownSource(body, updated, 'md')).toBe('\n* a\n* b\n* c\n\nAfter.\n')
    })
  })

  it('keeps a list in a marker style the editor no longer writes', () => {
    const body = '\n* Star item\n* Another\n\nText.\n'
    expect(preserveMarkdownSource(body, '- Star item\n- Another\n\nText, edited.', 'md')).toBe(
      '\n* Star item\n* Another\n\nText, edited.\n',
    )
  })

  it("writes new text in a CRLF body's own line endings", () => {
    const body = '\r\n## H\r\n\r\nPara one.\r\n\r\nTwo _lines_\r\nof text.\r\n\r\n- a\r\n- b\r\n'
    const updated = '## H\n\nPara one, edited.\n\nTwo *lines*\nof text.\n\n* a\n* b\n* c\n\nNew.'
    expect(preserveMarkdownSource(body, updated, 'md')).toBe(
      '\r\n## H\r\n\r\nPara one, edited.\r\n\r\nTwo _lines_\r\nof text.\r\n\r\n- a\r\n- b\r\n- c\r\n\r\nNew.\r\n',
    )
  })

  describe('mdx', () => {
    const MDX_BODY = `
# Title

Intro paragraph.

<Callout type="info">
Inside the callout.
</Callout>

<Chart data={[1, 2, 3]} />

- item
- item two
`
    // MDXEditor indents a JSX element's children and uses its own bullets.
    const MDX_EXPORT = `# Title

Intro paragraph.

<Callout type="info">
  Inside the callout.
</Callout>

<Chart data={[1, 2, 3]} />

* item
* item two`

    it('keeps untouched JSX blocks as written', () => {
      expect(preserveMarkdownSource(MDX_BODY, MDX_EXPORT, 'mdx')).toBe(MDX_BODY)
    })

    it('changes only an edited paragraph next to JSX', () => {
      const updated = edit(MDX_EXPORT, 'Intro paragraph.', 'Intro paragraph, edited.')
      expect(preserveMarkdownSource(MDX_BODY, updated, 'mdx')).toBe(
        edit(MDX_BODY, 'Intro paragraph.', 'Intro paragraph, edited.'),
      )
    })

    it('writes the edit as sent when the body on disk is not valid MDX', () => {
      expect(preserveMarkdownSource('\nCosts { 5 dollars.\n', 'Costs 5 dollars.', 'mdx')).toBe(
        'Costs 5 dollars.',
      )
    })
  })

  it('writes the edit as sent when no splice reads back as the edit', () => {
    parseControl.corruptAfter = 2
    const updated = `${EXPORT}\n\n![Logo](/assets/logo.png)`
    expect(preserveMarkdownSource(BODY, updated, 'md')).toBe(updated)
    // Both splice attempts were checked (the original, the edit, then one parse per attempt).
    expect(parseControl.calls).toBe(4)
  })
})

describe('serializeFrontmatter body preservation', () => {
  const FILE = `---\ntitle: Hello\n---\n${BODY}`

  it('returns the file byte-for-byte on a save that changes nothing', () => {
    expect(serializeFrontmatter(EXPORT, { title: 'Hello' }, FILE, 'md')).toBe(FILE)
  })

  it('keeps the blank line after the frontmatter when the splice falls back', () => {
    const file = '---\ntitle: Hello\n---\n\nCosts { 5 dollars.\n'
    expect(serializeFrontmatter('Costs 5 dollars.', { title: 'Hello' }, file, 'mdx')).toBe(
      '---\ntitle: Hello\n---\n\nCosts 5 dollars.\n',
    )
  })

  it('keeps a body that sits flush against the frontmatter on disk flush', () => {
    const file = '---\ntitle: Hello\n---\nOne.\n'
    expect(serializeFrontmatter('Two.', { title: 'Hello' }, file, 'md')).toBe(
      '---\ntitle: Hello\n---\nTwo.\n',
    )
  })

  it('opens a new file body with a blank line after the frontmatter', () => {
    expect(serializeFrontmatter('Body.', { title: 'Hello' }, undefined, 'md')).toBe(
      '---\ntitle: Hello\n---\n\nBody.\n',
    )
  })

  it('writes a Prettier-clean file when the editor writes in its configured style', async () => {
    // The style MARKDOWN_EXPORT_OPTIONS gives the editor (editor/fields/markdown-export-options.ts).
    const updated = `${edit(EXPORT, '* Third item', '* Third item\n* New _item_')}\n\n- An appended list\n\n---\n\nNew **closing**.`
    const out = serializeFrontmatter(updated, { title: 'Hello' }, FILE, 'md')
    expect(await format(out, { parser: 'markdown' })).toBe(out)
    expect(await format(FILE, { parser: 'markdown' })).toBe(FILE)
  })
})
