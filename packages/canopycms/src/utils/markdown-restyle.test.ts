import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import matter from 'gray-matter'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { format } from 'prettier'
import { describe, expect, it } from 'vitest'

import { markdownBlocks, preserveMarkdownSource } from './markdown-body-splice'
import { restyleMarkdown, type MdNode } from './markdown-restyle'

/** `text` restyled whole, as a new file's body is. */
function restyled(text: string, format: 'md' | 'mdx' = 'md'): string {
  return preserveMarkdownSource(undefined, text, format)
}

const meaning = (text: string, format: 'md' | 'mdx' = 'md') =>
  markdownBlocks(text, format)?.map((block) => block.meaning)

describe('restyleMarkdown', () => {
  it.each([
    ['bullets', '* a\n* b\n  + nested', '- a\n- b\n  - nested'],
    ['bullets alternating for a list that follows another', '+ a\n+ b\n\n\n* c', '- a\n- b\n\n* c'],
    ['ordered delimiters', '1) a\n2) b\n\n1. c', '1. a\n2. b\n\n1) c'],
    ['ordered numbering counting up', '1. a\n3. b\n7. c', '1. a\n2. b\n3. c'],
    ['ordered numbering all one number', '1. a\n1. b\n5. c', '1. a\n1. b\n1. c'],
    ['ordered numbering that keeps each width', '9. a\n12. b\n13. c', '9. a\n10. b\n11. c'],
    ['ordered numbering from a repeated start', '2. a\n2. b\n2. c', '2. a\n3. b\n4. c'],
    [
      'rules inside a list',
      '- a\n\n  ---\n\n- b\n\n* c\n\n  ***',
      '- a\n\n  ***\n\n- b\n\n* c\n\n  ---',
    ],
    [
      'consecutive link reference definitions',
      'Text [a] [b].\n\n[a]: https://a.example\n\n[b]: https://b.example',
      'Text [a] [b].\n\n[a]: https://a.example\n[b]: https://b.example',
    ],
    [
      'emphasis after a `_` in a URL or math',
      'See https://x.com/a_b, $a_b$ and *c*.',
      'See https://x.com/a_b, $a_b$ and _c_.',
    ],
    ['emphasis in strikethrough', 'x~~*a*~~', 'x~~_a_~~'],
    ['tilde fences in a block quote', '> ~~~\n> x\n> ~~~', '> ```\n> x\n> ```'],
    ['strong', '__bold__ and **bold**', '**bold** and **bold**'],
    ['emphasis', '*a* and _b_ (*c*) *"q"*.', '_a_ and _b_ (_c_) _"q"_.'],
    ['emphasis inside emphasis', '*a _b_ c*', '_a *b* c_'],
    ['emphasis around strong', '***x*** y', '_**x**_ y'],
    ['rules', 'a\n\n***\n\nb\n\n* * *\n\nc\n\n___', 'a\n\n---\n\nb\n\n---\n\nc\n\n---'],
    ['setext headings', 'One\n===\n\nTwo\n---', '# One\n\n## Two'],
    ['ATX headings', '#   One #\n\n## Two ##', '# One\n\n## Two'],
    ['tilde fences', '~~~text\nx\n~~~', '```text\nx\n```'],
    ['blank lines between blocks', 'a\n\n\n\nb\n- c\n# d', 'a\n\nb\n\n- c\n\n# d'],
    ['blank lines in a block quote', '> a\n>\n>\n> b\n> - c', '> a\n>\n> b\n>\n> - c'],
    ['blank lines in a loose list', '- a\n\n\n- b\n\n  p\n\n\n  q', '- a\n\n- b\n\n  p\n\n  q'],
    ['trailing space before a soft line ending', 'word \nnext\t\nlast', 'word\nnext\nlast'],
    ['escaped `_` between letters', 'a\\_b and 1\\_2', 'a_b and 1_2'],
    [
      'tables',
      '| a | b | c |\n|-|:-:|--:|\n| long | x | y |',
      '| a    |  b  |   c |\n| ---- | :-: | --: |\n| long |  x  |   y |',
    ],
  ])('restyles %s', async (_case, typed, expected) => {
    const out = restyled(typed)
    expect(out).toBe(expected)
    expect(meaning(out)).toEqual(meaning(typed))
    expect(await format(out, { parser: 'markdown' })).toBe(`${out}\n`)
  })

  it.each([
    ['emphasis beside a word', 'Many *API*s, 5*x* and un***believ***able.'],
    ['emphasis after a literal `_` (Prettier misreads `a_b _x_`)', 'a_b then *x*'],
    ['a multi-line setext heading', 'One\ntwo\n==='],
    ['a fence holding backticks', '~~~\n```\n~~~'],
    ['a tight list', '- a\n- b'],
    ['a tight item with a nested list', '- a\n  - b'],
    ['a list with a paragraph between it and the next', '- a\n\npara\n\n- b'],
    ['an ordered list whose renumbering would change a width', '8. a\n10. b'],
    ['ordered lists typed as Prettier numbers them', '3. a\n1. b\n1. c\n\n- x\n\n0. d\n1. e\n1. f'],
    ['an escaped `_` in math', 'Energy $E\\_k = mv^2$ and\n\n$$\nx\\_1\n$$'],
    ['an escaped `_` in a wiki link', 'See [[My\\_Page]].'],
    ['an escaped `_` in a link or at a word edge', '[a\\_b](u) and end\\_ and \\_start'],
    [
      'link destinations, titles and alt',
      '[a](https://x.com/?a=1&b=2 "R&D") ![Q&A](i.png?w=1&h=2)',
    ],
    ['character references and escapes', 'A&nbsp;B &#x202E; \\$5 [[Page]] \\# `a\\_b`'],
    ['bare URLs', 'See https://x.com and www.y.com and me@x.com.'],
    ['HTML', '<div>\n*not markdown*\n</div>'],
    ['a body with a byte-order mark', '\uFEFF* a'],
    ['a table with text Prettier measures by display width', '| a |\n|-|\n| \u2B1C x |'],
  ])('leaves %s as typed', (_case, typed) => {
    expect(restyled(typed)).toBe(typed)
  })

  it('keeps JSX as typed and restyles the markdown inside it', () => {
    const typed = '<C a=\'he said "hi"\' u="x&nbsp;y">\n*x* and https://z.com\n</C>'
    expect(restyled(typed, 'mdx')).toBe(typed.replace('*x*', '_x_'))
  })

  it("writes new lines in a CRLF body's own line endings", () => {
    expect(restyled('* a\r\n\r\n\r\n\r\npara\r\n> q\r\n> - r')).toBe(
      '- a\r\n\r\npara\r\n\r\n> q\r\n>\r\n> - r',
    )
  })

  it('keeps the restyle of every block that reads back when one does not', () => {
    const source = '* a\n\n*b*\n\n+ c\n\n*d*'
    const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    const wanted = JSON.stringify(meaning(source))
    // Stands in for a block whose restyle would not mean the same: here, the second list's.
    const readsBack = (text: string): MdNode | undefined =>
      text.includes('\n- c') || text.includes('\n* c') || JSON.stringify(meaning(text)) !== wanted
        ? undefined
        : fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    expect(restyleMarkdown(source, tree, () => false, readsBack)?.text).toBe(
      '- a\n\n_b_\n\n+ c\n\n_d_',
    )
  })

  it('finds the blocks that do not read back in a few parses each, not one per block', () => {
    const source = Array.from({ length: 200 }, (_, i) => `*p${i}*`).join('\n\n')
    const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    let parses = 0
    // Stands in for one block, the 101st, whose restyle would not mean the same.
    const readsBack = (text: string): MdNode | undefined => {
      parses++
      return text.includes('_p100_') ? undefined : fromMarkdown(text)
    }
    const out = restyleMarkdown(source, tree, () => false, readsBack)?.text
    expect(out).toBe(
      source.replace(/\*(p\d+)\*/g, (all, p: string) => (p === 'p100' ? all : `_${p}_`)),
    )
    expect(parses).toBeLessThan(20)
  })

  it('restyles only the blocks it is not told to keep', () => {
    const source = '* a\n\n*b*\n\n*c*'
    const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    const readsBack = (text: string): MdNode => fromMarkdown(text)
    expect(restyleMarkdown(source, tree, (index) => index !== 1, readsBack)?.text).toBe(
      '* a\n\n_b_\n\n*c*',
    )
  })
})

/**
 * What a restyle may not change: every character but whitespace and marker characters (`=` for
 * a setext underline), once an
 * escaped `_` (which the restyle may unescape) is read as `_`. Content digits, `.`, `-` and the
 * like are dropped too; the tree check covers those.
 */
function skeleton(text: string): string {
  return text.replace(/\\(?=_)/g, '').replace(/[\s*_\-+#=~`|:>.)0-9]/g, '')
}

describe('restyleMarkdown over the repository', () => {
  const root = path.resolve(__dirname, '../../../..')
  const files = execFileSync('git', ['ls-files', '*.md', '*.mdx'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file !== '' && fs.existsSync(path.join(root, file)))

  it('finds the corpus', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('changes nothing but markers and whitespace, and keeps a Prettier-clean file clean', async () => {
    const problems: string[] = []
    for (const file of files) {
      const raw = fs.readFileSync(path.join(root, file), 'utf8')
      const body = matter(raw, {}).content
      const kind = file.endsWith('.mdx') ? 'mdx' : 'md'
      if (meaning(body, kind) === undefined) continue
      const out = restyled(body, kind)
      if (skeleton(out) !== skeleton(body)) problems.push(`${file}: changed more than markers`)
      if (JSON.stringify(meaning(out, kind)) !== JSON.stringify(meaning(body, kind))) {
        problems.push(`${file}: changed meaning`)
      }
      if (kind === 'md' && (await format(body, { parser: 'markdown' })) === body) {
        if ((await format(out, { parser: 'markdown' })) !== out) {
          problems.push(`${file}: no longer Prettier-clean`)
        }
      }
    }
    expect(problems).toEqual([])
  }, 120_000)

  it('restores a Prettier-clean file whose bullets and emphasis were typed in another style', async () => {
    const problems: string[] = []
    let checked = 0
    for (const file of files.filter((name) => name.endsWith('.md'))) {
      const body = matter(fs.readFileSync(path.join(root, file), 'utf8'), {}).content
      if ((await format(body, { parser: 'markdown' })) !== body) continue
      const typed = otherStyle(body)
      if (typed === body || JSON.stringify(meaning(typed)) !== JSON.stringify(meaning(body))) {
        continue
      }
      checked++
      if (restyled(typed) !== body) problems.push(file)
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(50)
  }, 120_000)

  it('saves a source-mode edit to one block of a Prettier-clean file as that edit alone', async () => {
    const problems: string[] = []
    let checked = 0
    for (const file of files.filter((name) => name.endsWith('.md'))) {
      const body = matter(fs.readFileSync(path.join(root, file), 'utf8'), {}).content
      if ((await format(body, { parser: 'markdown' })) !== body) continue
      const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
      const blocks = (tree.children ?? [])
        .filter((block) => block.type === 'list' || block.type === 'paragraph')
        .slice(0, 4)
      for (const block of blocks) {
        const from = block.position?.start.offset
        const to = block.position?.end.offset
        const at = lastTextEnd(block)
        if (from === undefined || to === undefined || at === undefined) continue
        const insert = (text: string) => `${text.slice(0, at)} zz${text.slice(at)}`
        const expected = insert(body)
        const typed = insert(otherStyle(body, from, to))
        if (JSON.stringify(meaning(typed)) !== JSON.stringify(meaning(expected))) continue
        checked++
        if (preserveMarkdownSource(body, typed, 'md') !== expected) problems.push(`${file}@${from}`)
      }
    }
    expect(problems).toEqual([])
    expect(checked).toBeGreaterThan(100)
  }, 120_000)
})

/** Where the last `text` node under `node` ends. */
function lastTextEnd(node: MdNode): number | undefined {
  if (node.type === 'text') return node.position?.end.offset
  const children = node.children ?? []
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i]
    const end = child === undefined ? undefined : lastTextEnd(child)
    if (end !== undefined) return end
  }
  return undefined
}

/**
 * `body` with its `-` bullets as `*` and its `_` emphasis as `*`, as a source editor might type
 * it, in `[from, to)`. Each change keeps the length, so offsets into `body` still hold.
 */
function otherStyle(body: string, from = 0, to = body.length): string {
  const edits: { at: number; text: string }[] = []
  const walk = (node: MdNode): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined && start >= from && end <= to) {
      if (node.type === 'listItem' && body[start] === '-') edits.push({ at: start, text: '*' })
      if (node.type === 'emphasis' && body[start] === '_' && body[end - 1] === '_') {
        edits.push({ at: start, text: '*' }, { at: end - 1, text: '*' })
      }
    }
    node.children?.forEach(walk)
  }
  walk(fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))
  const chars = [...body]
  let out = ''
  let index = 0
  for (const char of chars) {
    out += edits.find((edit) => edit.at === index)?.text ?? char
    index += char.length
  }
  return out
}
