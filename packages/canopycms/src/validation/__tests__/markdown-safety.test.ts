import { describe, expect, it } from 'vitest'

import type { EntrySchema } from '../../config'
import { validateEntryFormValue } from '../entry-validator'
import { findUnsafeMarkdown, validateMarkdownSafety } from '../markdown-safety'

const mdx = (source: string) => findUnsafeMarkdown(source, 'mdx')
const md = (source: string) => findUnsafeMarkdown(source, 'md')

describe('findUnsafeMarkdown: MDX that runs code is refused', () => {
  const refused: Array<[string, string, RegExp]> = [
    ['an import', "import Chart from './chart'\n\n# Hi", /import\/export/],
    ['an export', 'export const meta = { a: 1 }', /import\/export/],
    [
      'a flow expression',
      'Intro\n\n{fetch("/api/canopycms/x", { method: "POST" })}',
      /expressions/,
    ],
    ['a text expression', 'Hello {window.parent.document.title} there', /expressions/],
    [
      'an expression inside a component',
      '<Callout>\n  {globalThis.x = 1}\n</Callout>',
      /expressions/,
    ],
    ['an IIFE', '{(() => { new Image().src = "//x" })()}', /expressions/],
    ['an identifier', 'Total: {count}', /expressions/],
    ['a template literal with a hole', '{`a ${b}`}', /expressions/],
    ['a computed attribute value', '<Chart data={load()} />', /plain value/],
    ['an identifier attribute value', '<Chart data={rows} />', /plain value/],
    ['a call nested in an object value', '<Chart opts={{ a: f() }} />', /plain value/],
    ['a getter in an object value', '<Chart opts={{ get a() { return 1 } }} />', /plain value/],
    ['a computed key in an object value', '<Chart opts={{ [k]: 1 }} />', /plain value/],
    ['a spread inside an array value', '<Chart rows={[...xs]} />', /plain value/],
    ['a spread attribute', '<Chart {...props} />', /spread/],
    ['a member-expression component', '<motion.div animate="x" />', /<motion\.div>/],
    ['a script tag', '<script>alert(1)</script>', /<script>/],
    ['a script tag inline', 'Text <script>alert(1)</script> more', /<script>/],
    ['an iframe with srcdoc', '<iframe srcdoc="<script>parent.x()</script>" />', /<iframe>/],
    ['an object tag', '<object data="/x.swf" />', /<object>/],
    ['an embed tag', '<embed src="/x" />', /<embed>/],
    ['a base tag', '<base href="https://evil.example/" />', /<base>/],
    ['a form', '<form action="/api/canopycms/x"><button>Go</button></form>', /<form>/],
    ['a style tag', '<style>{"body{}"}</style>', /<style>/],
    ['a link tag', '<link rel="stylesheet" href="https://evil.example/x.css" />', /<link>/],
    ['an svg', '<svg><a href="#">x</a></svg>', /<svg>/],
    ['a custom element', '<my-widget />', /<my-widget>/],
    ['a namespaced tag', '<svg:script />', /<svg:script>/],
    ['an event-handler attribute', '<img src="/a.png" onerror="alert(1)" />', /onerror/],
    ['a camel-case handler on a component', '<Button onClick="steal()" />', /onClick/],
    [
      'dangerouslySetInnerHTML',
      '<div dangerouslySetInnerHTML={{ __html: "<img>" }} />',
      /dangerouslySetInnerHTML/,
    ],
    ['srcDoc on a component', '<Frame srcDoc="<script></script>" />', /srcDoc/],
    ['a javascript: link', '[click](javascript:fetch("/api"))', /javascript:/],
    [
      'a javascript: link spelled with a character reference',
      '[click](&#106;avascript:alert(1))',
      /javascript:/,
    ],
    [
      'a javascript: link with a tab inside the scheme',
      '[click](<java\tscript:alert(1)>)',
      /scheme/,
    ],
    ['an upper-case JAVASCRIPT: link', '[click](JAVASCRIPT:alert(1))', /scheme/],
    ['a javascript: definition', '[click][a]\n\n[a]: javascript:alert(1)', /javascript:/],
    ['a javascript: image', '![x](javascript:alert(1))', /javascript:/],
    ['a javascript: href on an anchor', '<a href="javascript:alert(1)">x</a>', /javascript:/],
    ['a javascript: href with a leading space', '<a href=" javascript:alert(1)">x</a>', /scheme/],
    [
      'a javascript: href via a character reference',
      '<a href="&#x6A;avascript:alert(1)">x</a>',
      /scheme/,
    ],
    [
      'a javascript: href on a component',
      '<Link href="javascript:alert(1)">x</Link>',
      /javascript:/,
    ],
    ['an expression href', '<a href={"javascript:alert(1)"}>x</a>', /plain/],
    ['a data:text/html link', '[x](data:text/html,<script>alert(1)</script>)', /data:/],
    ['a vbscript: src', '<img src="vbscript:msgbox(1)" />', /vbscript:/],
    [
      'a javascript: srcset candidate',
      '<img src="/a.png" srcSet="/a.png 1x, javascript:alert(1) 2x" />',
      /javascript:/,
    ],
    ['a javascript: xlinkHref', '<Icon xlinkHref="javascript:alert(1)" />', /javascript:/],
    ['a javascript: formAction', '<Submit formAction="javascript:alert(1)" />', /javascript:/],
  ]

  it.each(refused)('refuses %s', (_label, source, pattern) => {
    const issues = mdx(source)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((i) => i.message).join('\n')).toMatch(pattern)
  })

  it('reports the line of the offending construct', () => {
    const [issue] = mdx('# Title\n\nSome text\n\n{danger()}\n')
    expect(issue?.line).toBe(5)
    expect(issue?.message).toMatch(/line 5/)
  })

  it('refuses a body that does not parse, rather than letting it through unchecked', () => {
    const issues = mdx('Text <Callout>unclosed')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/does not parse/)
  })

  it('refuses an expression only a site with remark-gfm runs: a footnote definition', () => {
    // Without GFM, `[^1]: {x()}` is a link definition whose URL is the text `{x()}`.
    expect(
      mdx('Text[^1]\n\n[^1]: {x()}')
        .map((i) => i.message)
        .join(),
    ).toMatch(/expressions/)
  })

  it('refuses an expression only a site without remark-gfm runs: after a bare www. URL', () => {
    // With GFM, `www.example.com/{x()}` is one autolink literal and the braces are its URL.
    expect(
      mdx('See www.example.com/{x()}')
        .map((i) => i.message)
        .join(),
    ).toMatch(/expressions/)
  })
})

describe('findUnsafeMarkdown: MDX that runs no code is accepted', () => {
  const accepted: Array<[string, string]> = [
    ['plain markdown', '# Title\n\nSome *text* with a [link](/docs/intro) and `code {x}`.'],
    ['a fenced code block holding code', '```js\nimport x from "y"\n{fetch()}\n```'],
    ['an MDX comment', 'Text {/* a note for editors */} more'],
    ['a flow comment', '{/*\n  hidden\n*/}'],
    [
      'a component with string props',
      '<Callout type="warning" title="Careful">Body *text*</Callout>',
    ],
    ['a self-closing component', '<YouTube id="dQw4w9WgXcQ" />'],
    ['a boolean attribute', '<Details open>Hidden</Details>'],
    ['a number literal attribute', '<Chart height={300} />'],
    ['a negative number attribute', '<Offset by={-4} />'],
    ['a string literal attribute', '<Chart title={"Sales"} />'],
    ['a static template literal attribute', '<Chart title={`Sales`} />'],
    ['an array of literals', '<Tabs items={["One", "Two", 3, null, true]} />'],
    [
      'an object of literals',
      '<Box style={{ color: "red", "margin-top": 4, nested: { a: [1] } }} />',
    ],
    ['a literal text expression', 'A{" "}B'],
    ['a fragment', '<>Grouped</>'],
    [
      'safe HTML',
      '<div className="note"><p>Para <strong>bold</strong> <a href="/x">x</a></p></div>',
    ],
    ['a details element', '<details><summary>More</summary>Hidden</details>'],
    [
      'a table',
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
    ],
    ['an image with a srcset', '<img src="/a.png" srcSet="/a.png 1x, /a@2x.png 2x" alt="" />'],
    ['a video with a poster', '<video src="/v.mp4" poster="/p.png" controls />'],
    [
      'http, https, mailto and tel links',
      '[a](http://x.test) [b](https://x.test) [c](mailto:a@x.test) [d](tel:+15551234)',
    ],
    ['relative and fragment links', '[a](/a) [b](../b) [c](#c) [d](?q=1) [e](//cdn.x.test/e)'],
    ['a raster data: image', '![dot](data:image/png;base64,iVBORw0KGgo=)'],
    ['an entry link, which the site resolves to a path', '[About](entry:abcdefghijkm#team)'],
    ['a path with a colon after the first slash', '[a](/a:b)'],
    ['an underscore-led component', '<_Private />'],
  ]

  it.each(accepted)('accepts %s', (_label, source) => {
    expect(mdx(source)).toEqual([])
  })
})

describe('findUnsafeMarkdown: markdown dialect', () => {
  it('refuses a javascript: link', () => {
    expect(md('[x](javascript:alert(1))')).toHaveLength(1)
  })

  it('refuses a javascript: autolink', () => {
    expect(md('<javascript:alert(1)>')).toHaveLength(1)
  })

  it('treats braces, imports and tags as text, which markdown renders as text', () => {
    expect(md('import x from "y"\n\n{fetch()} <Callout>x</Callout>')).toEqual([])
  })
})

describe('validateMarkdownSafety', () => {
  const schema: EntrySchema = [
    { name: 'title', type: 'string' },
    { name: 'summary', type: 'mdx' },
    { name: 'trusted', type: 'mdx', executable: true },
    { name: 'notes', type: 'markdown' },
    { name: 'callouts', type: 'mdx', list: true },
    {
      name: 'sections',
      type: 'object',
      list: true,
      fields: [{ name: 'text', type: 'mdx' }],
    },
    {
      name: 'blocks',
      type: 'block',
      templates: [{ name: 'prose', fields: [{ name: 'text', type: 'mdx' }] }],
    },
  ]

  it('checks mdx fields wherever they nest, and names each offending field', () => {
    const errors = validateMarkdownSafety(schema, 'json', {
      title: '{not markdown, a string field}',
      summary: '{a()}',
      callouts: ['fine', '{b()}'],
      sections: [{ text: 'ok' }, { text: 'import x from "y"' }],
      blocks: [{ template: 'prose', value: { text: '<script>x</script>' } }],
    })
    expect(errors.map((e) => e.fieldPath).sort()).toEqual(
      ['blocks[0].text', 'callouts[1]', 'sections[1].text', 'summary'].sort(),
    )
  })

  it('leaves an executable field alone', () => {
    expect(
      validateMarkdownSafety(schema, 'json', { trusted: 'import x from "y"\n\n{x()}' }),
    ).toEqual([])
  })

  it('checks a markdown field as markdown: links only', () => {
    expect(validateMarkdownSafety(schema, 'json', { notes: '{x()}' })).toEqual([])
    expect(
      validateMarkdownSafety(schema, 'json', { notes: '[x](javascript:alert(1))' }).map(
        (e) => e.fieldPath,
      ),
    ).toEqual(['notes'])
  })

  it('folds every issue in one field into one error that counts the rest', () => {
    const [error] = validateMarkdownSafety(schema, 'json', { summary: '{a()}\n\n{b()}\n\n{c()}' })
    expect(error?.message).toMatch(/line 1/)
    expect(error?.message).toMatch(/2 more/)
  })

  describe('the body', () => {
    const withBody = (bodyType: 'markdown' | 'mdx', executable?: boolean): EntrySchema => [
      { name: 'title', type: 'string' },
      { name: 'content', type: bodyType, isBody: true, ...(executable ? { executable } : {}) },
    ]

    it('is MDX in an mdx entry even when its field is typed markdown', () => {
      const errors = validateMarkdownSafety(withBody('markdown'), 'mdx', { content: '{x()}' })
      expect(errors.map((e) => e.fieldPath)).toEqual(['content'])
    })

    it('is markdown in an md entry even when its field is typed mdx', () => {
      expect(validateMarkdownSafety(withBody('mdx'), 'md', { content: '{x()}' })).toEqual([])
    })

    it('is checked when the schema declares no body field', () => {
      const errors = validateMarkdownSafety([{ name: 'title', type: 'string' }], 'mdx', {
        body: 'import x from "y"',
      })
      expect(errors.map((e) => e.fieldPath)).toEqual(['body'])
    })

    it('is left alone when its field is executable', () => {
      expect(validateMarkdownSafety(withBody('mdx', true), 'mdx', { content: '{x()}' })).toEqual([])
    })

    it('is not a body in a json entry, where an isBody field is an ordinary field', () => {
      const errors = validateMarkdownSafety(withBody('markdown'), 'json', { content: '{x()}' })
      expect(errors).toEqual([])
    })
  })

  it('runs in the editor through validateEntryFormValue, on the body the editor keeps under `body`', () => {
    const fields: EntrySchema = [{ name: 'content', type: 'mdx', isBody: true }]
    const errors = validateEntryFormValue(fields, 'mdx', { body: '<script>x</script>' })
    expect(errors.map((e) => e.fieldPath)).toEqual(['content'])
  })
})
