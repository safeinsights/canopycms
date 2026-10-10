import { describe, expect, it } from 'vitest'

import type { EntrySchema, MdxAllowlist } from '../../config'
import { validateEntryFormValue } from '../entry-validator'
import { findMarkdownSafetyIssues, findUnsafeMarkdown, splitByStored } from '../markdown-safety'
import { resolveMdxAllowlist } from '../mdx-allowlist'

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
    [
      'the content function MDX defines, which recurses forever',
      '<_createMdxContent />',
      /<_createMdxContent>/,
    ],
    ['the MDXContent binding', '<MDXContent />', /<MDXContent>/],
    ['the MDXLayout binding', '<MDXLayout>x</MDXLayout>', /<MDXLayout>/],
    ['a dollar-led name', '<$x />', /<\$x>/],
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
    ['a javascript: router link', '<Link to="javascript:alert(1)">x</Link>', /javascript:/],
    ['a javascript: url prop', '<Card url="javascript:alert(1)" />', /javascript:/],
    ['a javascript: URL in any prop', '<Card link="javascript:alert(1)" />', /javascript:/],
    ['a vbscript: URL in any prop', '<Card target="vbscript:x" />', /vbscript:/],
    [
      'a javascript: URL nested in a static value',
      '<Nav items={[{ "href": "javascript:alert(1)" }]} />',
      /javascript:/,
    ],
    [
      'a javascript: URL in a static template literal',
      '<Card link={`javascript:alert(1)`} />',
      /javascript:/,
    ],
    ['an Alpine directive on a tag', '<div x-data="{}" x-init="alert(1)">x</div>', /x-data/],
    ['an htmx handler on a tag', '<span hx-on:click="alert(1)">x</span>', /hx-on:click/],
    ['a data- attribute on a tag', '<span data-run="alert(1)">x</span>', /data-run/],
  ]

  it.each(refused)('refuses %s', (_label, source, pattern) => {
    const issues = mdx(source)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.map((i) => i.message).join('\n')).toMatch(pattern)
  })

  it('refuses a body nested too deeply to check, rather than throwing', () => {
    const issues = mdx('>'.repeat(5000) + ' x')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.key).toBeUndefined()
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
    ['props that merely start with on', '<Callout online ongoing="yes" onlyMobile />'],
    ['a plain string prop with a colon', '<Callout title="Note: read this" />'],
    [
      'common attributes on tags',
      '<td colSpan="2" className="x" id="a" aria-label="b" title="t">1</td>',
    ],
    ['prose that starts with Data:', '<img src="/a.png" alt="Data: sales by region" />'],
    ['a title that starts with data:', '<Callout title="data: see the 2024/25 table" />'],
    [
      'a static value holding ordinary URLs',
      '<Nav items={[{ href: "/docs" }, { href: "https://x.test" }]} />',
    ],
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

describe('findMarkdownSafetyIssues', () => {
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
    const errors = findMarkdownSafetyIssues(schema, 'json', {
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
      findMarkdownSafetyIssues(schema, 'json', { trusted: 'import x from "y"\n\n{x()}' }),
    ).toEqual([])
  })

  it('checks a markdown field as markdown: links only', () => {
    expect(findMarkdownSafetyIssues(schema, 'json', { notes: '{x()}' })).toEqual([])
    expect(
      findMarkdownSafetyIssues(schema, 'json', { notes: '[x](javascript:alert(1))' }).map(
        (e) => e.fieldPath,
      ),
    ).toEqual(['notes'])
  })

  describe('the body', () => {
    const withBody = (bodyType: 'markdown' | 'mdx', executable?: boolean): EntrySchema => [
      { name: 'title', type: 'string' },
      { name: 'content', type: bodyType, isBody: true, ...(executable ? { executable } : {}) },
    ]

    it('is MDX in an mdx entry even when its field is typed markdown', () => {
      const errors = findMarkdownSafetyIssues(withBody('markdown'), 'mdx', { content: '{x()}' })
      expect(errors.map((e) => e.fieldPath)).toEqual(['content'])
    })

    it('is markdown in an md entry even when its field is typed mdx', () => {
      expect(findMarkdownSafetyIssues(withBody('mdx'), 'md', { content: '{x()}' })).toEqual([])
      // An HTML comment, common in markdown, does not parse as MDX.
      expect(
        findMarkdownSafetyIssues(withBody('mdx'), 'md', { content: 'x\n\n<!-- c -->' }),
      ).toEqual([])
    })

    it('is markdown in an md entry when its field is typed markdown', () => {
      expect(findMarkdownSafetyIssues(withBody('markdown'), 'md', { content: '{x()}' })).toEqual([])
    })

    it('is checked when the schema declares no body field', () => {
      const errors = findMarkdownSafetyIssues([{ name: 'title', type: 'string' }], 'mdx', {
        body: 'import x from "y"',
      })
      expect(errors.map((e) => e.fieldPath)).toEqual(['body'])
    })

    it('is left alone when its field is executable', () => {
      expect(findMarkdownSafetyIssues(withBody('mdx', true), 'mdx', { content: '{x()}' })).toEqual(
        [],
      )
    })

    it('is not a body in a json entry, where an isBody field is an ordinary field', () => {
      const errors = findMarkdownSafetyIssues(withBody('markdown'), 'json', { content: '{x()}' })
      expect(errors).toEqual([])
    })
  })

  it('is left to the server: the editor does not block a save on it', () => {
    // A save may keep code the stored entry already holds, which only the server can tell.
    const fields: EntrySchema = [{ name: 'content', type: 'mdx', isBody: true }]
    expect(validateEntryFormValue(fields, 'mdx', { body: '<script>x</script>' })).toEqual([])
  })
})

describe('splitByStored', () => {
  const fields: EntrySchema = [
    { name: 'summary', type: 'mdx' },
    { name: 'aside', type: 'mdx' },
    { name: 'callouts', type: 'mdx', list: true },
  ]
  const find = (data: Record<string, unknown>) => findMarkdownSafetyIssues(fields, 'json', data)
  const split = (saved: Record<string, unknown>, stored: Record<string, unknown>) =>
    splitByStored(find(saved), find(stored))

  it('refuses every issue of a new entry, folded into one error per field', () => {
    const { refused, kept } = split({ summary: '{a()}\n\n{b()}\n\n{c()}' }, {})
    expect(kept).toEqual([])
    expect(refused).toHaveLength(1)
    expect(refused[0]?.message).toMatch(/line 1/)
    expect(refused[0]?.message).toMatch(/2 more/)
  })

  it('keeps a field holding code that is saved unchanged, while other fields change', () => {
    const stored = { summary: 'Intro\n\n{legacy()}\n\n<iframe src="/x" />', aside: 'Old' }
    const { refused, kept } = split({ ...stored, aside: 'New aside' }, stored)
    expect(refused).toEqual([])
    expect(kept.map((e) => e.fieldPath)).toEqual(['summary'])
    expect(kept[0]?.message).toMatch(/1 more/)
  })

  it('keeps an unchanged list item holding code wherever it moves in the list', () => {
    const { refused } = split({ callouts: ['ok', '{x()}'] }, { callouts: ['{x()}', 'ok'] })
    expect(refused).toEqual([])
  })

  it('refuses any change to a field holding code, since kept code reads what is around it', () => {
    const pairs: Array<[string, string]> = [
      // Text edited beside the code.
      ['Intro\n\n{legacy()}', 'Intro, edited\n\n{legacy()}'],
      // A sibling prop the kept function reads.
      ['<Run fn={(s) => s} arg="a" />', '<Run fn={(s) => s} arg="b" />'],
      // A new parent that calls a kept function.
      ['Intro {() => hit()}', 'Intro <BrowserOnly>{() => hit()}</BrowserOnly>'],
      // Markup a kept script reads.
      ['<script>{"run()"}</script>', '<script>{"run()"}</script>\n\n<span title="x">x</span>'],
      // New text inside a kept script.
      ['<script>console.log(1)</script>', '<script>steal(document.cookie)</script>'],
      // A call to what kept import/export defines.
      [
        'export const Foo = () => null\n\nIntro',
        'export const Foo = () => null\n\nIntro\n\n<Foo />',
      ],
      // A footnote definition no reference renders, made live.
      ['[^x]: {hit("E")}', 'See[^x]\n\n[^x]: {hit("E")}'],
      // A second copy of kept code.
      ['{legacy()}', '{legacy()}\n\n{legacy()}'],
      // Moved from a quote, where it compiles to different code.
      ['> {a\n> -b}', '{a\n> -b}'],
    ]
    for (const [stored, saved] of pairs) {
      expect(split({ summary: saved }, { summary: stored }).refused).toHaveLength(1)
    }
  })

  it('tells an author editing around stored code why the edit is refused', () => {
    const { refused } = split(
      { summary: 'Intro, edited\n\n{legacy()}' },
      { summary: 'Intro\n\n{legacy()}' },
    )
    expect(refused[0]?.message).toMatch(
      /already holds content it refuses.*unchanged or with that content removed/,
    )
    expect(split({ summary: '{new()}' }, {}).refused[0]?.message).not.toMatch(/already holds/)
  })

  it('refuses a stored field copied into a second list item', () => {
    const { refused, kept } = split({ callouts: ['{x()}', '{x()}'] }, { callouts: ['{x()}'] })
    expect(refused).toHaveLength(1)
    expect(kept).toHaveLength(1)
  })

  it('refuses stored code moved to a field of another name', () => {
    const { refused } = split({ aside: '{legacy()}' }, { summary: '{legacy()}' })
    expect(refused.map((e) => e.fieldPath)).toEqual(['aside'])
  })

  it('accepts removing the code', () => {
    expect(split({ summary: 'Intro, edited' }, { summary: 'Intro\n\n{legacy()}' }).refused).toEqual(
      [],
    )
  })

  it('keeps a field whatever its line endings', () => {
    const stored = {
      summary: 'export const meta = {\r\n  title: "x",\r\n}\r\n\r\nTotal: {a +\r\n  b}',
    }
    const saved = { summary: 'export const meta = {\n  title: "x",\n}\n\nTotal: {a +\n  b}' }
    expect(split(saved, stored).refused).toEqual([])
  })

  it('keeps code only in a field of the same dialect', () => {
    const blockFields: EntrySchema = [
      {
        name: 'blocks',
        type: 'block',
        templates: [
          { name: 'note', fields: [{ name: 'text', type: 'markdown' }] },
          { name: 'rich', fields: [{ name: 'text', type: 'mdx' }] },
        ],
      },
    ]
    const found = (template: string) =>
      findMarkdownSafetyIssues(blockFields, 'json', {
        blocks: [{ template, value: { text: '[a](javascript:x())' } }],
      })
    expect(splitByStored(found('rich'), found('note')).refused).toHaveLength(1)
    expect(splitByStored(found('rich'), found('rich')).refused).toEqual([])
  })

  describe('across block templates sharing a field name', () => {
    const blocks: EntrySchema = [
      {
        name: 'blocks',
        type: 'block',
        templates: [
          { name: 'narrow', fields: [{ name: 'm', type: 'mdx', mdxAllow: { components: {} } }] },
          { name: 'wide', fields: [{ name: 'm', type: 'mdx' }] },
        ],
      },
    ]
    // One issue under `narrow`, two under `wide`.
    const text = '<Foo a="javascript:alert(1)" b="javascript:alert(2)" />'
    const findings = (...templates: string[]) =>
      findMarkdownSafetyIssues(blocks, 'json', {
        blocks: templates.map((template) => ({ template, value: { m: text } })),
      })

    it('keeps one saved field per stored field of the same template', () => {
      const { refused, kept } = splitByStored(findings('wide', 'wide'), findings('wide'))
      expect(kept.map((e) => e.fieldPath)).toEqual(['blocks[0].m'])
      expect(refused.map((e) => e.fieldPath)).toEqual(['blocks[1].m'])
    })

    it('refuses stored content moved into a template whose allowlist refuses it', () => {
      expect(splitByStored(findings('narrow'), findings('wide')).kept).toEqual([])
      expect(splitByStored(findings('narrow', 'narrow'), findings('wide')).kept).toEqual([])
    })
  })

  it('never keeps a body that does not parse, which cannot be checked', () => {
    const { refused, kept } = split({ summary: '<A>{x()}' }, { summary: '<A>{x()}' })
    expect(kept).toEqual([])
    expect(refused.map((e) => e.fieldPath)).toEqual(['summary'])
  })
})

describe('a markdown field with renderAs: mdx', () => {
  const schema: EntrySchema = [
    { name: 'summary', type: 'markdown', renderAs: 'mdx' },
    { name: 'notes', type: 'markdown' },
    { name: 'trusted', type: 'markdown', renderAs: 'mdx', executable: true },
  ]
  const paths = (data: Record<string, unknown>) =>
    findMarkdownSafetyIssues(schema, 'json', data).map((e) => e.fieldPath)

  it.each([
    ['an expression', 'Total: {count}'],
    ['an import', "import X from './x'"],
    ['a script tag', '<script>alert(1)</script>'],
    ['a member-expression component', '<motion.div />'],
  ])('refuses %s, as an mdx field does', (_label, source) => {
    expect(paths({ summary: source })).toEqual(['summary'])
    expect(paths({ notes: source })).toEqual([])
  })

  it('keeps the markdown checks', () => {
    expect(paths({ summary: '[x](javascript:alert(1))' })).toEqual(['summary'])
  })

  it('accepts what an mdx field accepts', () => {
    expect(paths({ summary: '<Callout type="tip">**Hi** {/* note */}</Callout>' })).toEqual([])
  })

  it('is left alone when executable', () => {
    expect(paths({ trusted: '{x()}' })).toEqual([])
  })

  it('makes the body of an md entry MDX', () => {
    const fields: EntrySchema = [{ name: 'body', type: 'markdown', isBody: true, renderAs: 'mdx' }]
    expect(
      findMarkdownSafetyIssues(fields, 'md', { body: '{x()}' }).map((e) => e.fieldPath),
    ).toEqual(['body'])
  })

  it('keeps stored code only while the field is saved unchanged', () => {
    const stored = findMarkdownSafetyIssues(schema, 'json', { summary: 'Intro {legacy()}' })
    const same = findMarkdownSafetyIssues(schema, 'json', { summary: 'Intro {legacy()}' })
    const edited = findMarkdownSafetyIssues(schema, 'json', { summary: 'Intro! {legacy()}' })
    expect(splitByStored(same, stored).refused).toEqual([])
    expect(splitByStored(edited, stored).refused).toHaveLength(1)
  })
})

describe('findUnsafeMarkdown with an mdxAllow allowlist', () => {
  const narrow = resolveMdxAllowlist(
    {
      components: { Callout: { props: { type: ['info', 'warning'] } } },
      htmlTags: [],
      expressions: false,
      fragments: false,
    },
    undefined,
  )
  const messages = (source: string, allow: MdxAllowlist = {}) =>
    findUnsafeMarkdown(source, 'mdx', resolveMdxAllowlist(allow, undefined)).map((i) => i.message)
  const narrowMessages = (source: string) =>
    findUnsafeMarkdown(source, 'mdx', narrow).map((i) => i.message)

  it('accepts prose and the allowed component with an allowed string value', () => {
    expect(
      narrowMessages(
        '# Title\n\nSome **prose** with [a link](/x) and ![an image](/i.png).\n\n<Callout type="info">\n  Body\n</Callout>\n\n<Callout>No props</Callout>',
      ),
    ).toEqual([])
  })

  it('names a refused component and the allowed ones', () => {
    expect(narrowMessages('<Note>x</Note>')).toEqual([
      'Component <Note> is not allowed here; allowed: Callout (line 1)',
    ])
    expect(messages('<Note />', { components: { Callout: {}, Aside: {} } })).toEqual([
      'Component <Note> is not allowed here; allowed: Aside, Callout (line 1)',
    ])
    expect(messages('<Note />', { components: {} })).toEqual([
      'Component <Note> is not allowed: no components are allowed here (line 1)',
    ])
  })

  it('refuses an allowed component inline as well as in flow', () => {
    expect(narrowMessages('Text <Note>x</Note> more')).toHaveLength(1)
  })

  it('names a refused HTML tag and the allowed ones', () => {
    expect(narrowMessages('<div>x</div>')).toEqual([
      '<div> is not allowed here; allowed HTML tags: none (line 1)',
    ])
    expect(messages('<div><span>x</span></div>', { htmlTags: ['div', 'b'] })).toEqual([
      '<span> is not allowed here; allowed HTML tags: b, div (line 1)',
    ])
  })

  it('refuses every expression, inert ones and comments too, when expressions is false', () => {
    for (const source of ['{300}', 'a {" "} b', '{/* note */}', '{}']) {
      expect(narrowMessages(source)).toEqual([
        '{…} expressions are not allowed here, not even comments or plain values (line 1)',
      ])
      expect(messages(source)).toEqual([])
    }
  })

  it('takes a plain string where expressions is false, and refuses the same value in braces', () => {
    expect(narrowMessages('<Callout type="info">x</Callout>')).toEqual([])
    expect(narrowMessages('<Callout type={"info"}>x</Callout>')).toEqual([
      'type on <Callout> must be a plain "string": {…} values are not allowed here (line 1)',
    ])
  })

  it('names a refused prop value and the allowed ones', () => {
    expect(narrowMessages('<Callout type="danger">x</Callout>')).toEqual([
      'type="danger" on <Callout> is not allowed here; allowed values: "info", "warning" (line 1)',
    ])
    expect(narrowMessages('<Callout type>x</Callout>')).toHaveLength(1)
  })

  it('names a refused prop and the allowed ones', () => {
    expect(narrowMessages('<Callout kind="x">x</Callout>')).toEqual([
      'Prop kind on <Callout> is not allowed here; allowed: type (line 1)',
    ])
    expect(messages('<Callout kind="x" />', { components: { Callout: { props: {} } } })).toEqual([
      'Prop kind on <Callout> is not allowed: <Callout> takes no props here (line 1)',
    ])
  })

  it('reads a prop missing from the props map as not allowed, whatever its name', () => {
    expect(narrowMessages('<Callout constructor="x" toString="y">x</Callout>')).toHaveLength(2)
  })

  it('accepts any prop of a component with no props list', () => {
    expect(messages('<Callout kind="x" level={2} />', { components: { Callout: {} } })).toEqual([])
  })

  it('matches a value list against a literal expression, a bare prop and a string', () => {
    const allow: MdxAllowlist = {
      components: { Chart: { props: { height: [300], open: [true], tone: ['a'] } } },
    }
    expect(messages('<Chart height={300} open tone="a" />', allow)).toEqual([])
    expect(messages('<Chart height="300" />', allow)).toEqual([
      'height="300" on <Chart> is not allowed here; allowed values: 300 (line 1)',
    ])
    expect(messages('<Chart open={false} />', allow)).toEqual([
      'open={…} on <Chart> is not allowed here; allowed values: true (line 1)',
    ])
    expect(messages('<Chart tone={["a"]} />', allow)).toHaveLength(1)
  })

  it('refuses fragments when fragments is false', () => {
    expect(narrowMessages('<>x</>')).toEqual(['Fragments (<>…</>) are not allowed here (line 1)'])
    expect(messages('<>x</>')).toEqual([])
  })

  describe('only narrows the base policy', () => {
    it('still refuses a script URL in an allowed prop', () => {
      const allow: MdxAllowlist = { components: { Link: { props: { href: true } } } }
      expect(messages('<Link href="javascript:alert(1)" />', allow)).toHaveLength(1)
    })

    it('still refuses an allowed value list holding a script URL', () => {
      const allow: MdxAllowlist = {
        components: { Link: { props: { to: ['javascript:alert(1)'] } } },
      }
      expect(messages('<Link to="javascript:alert(1)" />', allow)).toHaveLength(1)
    })

    it('still refuses handlers, srcdoc and code in a prop the allowlist names', () => {
      const allow: MdxAllowlist = {
        components: { Button: { props: { onClick: true, srcDoc: true, data: true } } },
      }
      expect(messages('<Button onClick="x()" />', allow)).toHaveLength(1)
      expect(messages('<Button srcDoc="<script></script>" />', allow)).toHaveLength(1)
      expect(messages('<Button data={load()} />', allow)).toHaveLength(1)
    })

    it('still refuses a tag outside the safe set, and its unsafe attributes', () => {
      expect(messages('<script>x</script>', { htmlTags: ['script'] })).toHaveLength(1)
      expect(messages('<a onclick="x()">x</a>', { htmlTags: ['a'] })).toHaveLength(1)
    })

    it('still refuses a non-component name listed as a component', () => {
      expect(messages('<MDXContent />', { components: { MDXContent: {} } })).toHaveLength(1)
    })

    it('still refuses imports and spreads', () => {
      expect(narrowMessages("import X from './x'")).toHaveLength(1)
      expect(messages('<Callout {...p} />', { components: { Callout: {} } })).toHaveLength(1)
    })
  })
})

describe('resolveMdxAllowlist', () => {
  it('is the base policy when neither field nor site sets anything', () => {
    const allow = resolveMdxAllowlist(undefined, undefined)
    expect(allow.components).toBeUndefined()
    expect(allow.htmlTags.has('div')).toBe(true)
    expect(allow.expressions).toBe(true)
    expect(allow.fragments).toBe(true)
  })

  it('takes each key from the field, else the site', () => {
    const allow = resolveMdxAllowlist(
      { components: { Callout: {} }, expressions: true },
      { components: { Aside: {} }, htmlTags: [], expressions: false, fragments: false },
    )
    expect([...(allow.components?.keys() ?? [])]).toEqual(['Callout'])
    expect(allow.htmlTags.size).toBe(0)
    expect(allow.expressions).toBe(true)
    expect(allow.fragments).toBe(false)
  })

  it('takes an empty list from the field over the site', () => {
    const allow = resolveMdxAllowlist(
      { htmlTags: [], components: {} },
      { htmlTags: ['div'], components: { Aside: {} } },
    )
    expect(allow.htmlTags.size).toBe(0)
    expect(allow.components?.size).toBe(0)
  })
})

describe('findMarkdownSafetyIssues with a site mdxAllow', () => {
  const site: MdxAllowlist = { components: { Callout: {} } }
  const schema: EntrySchema = [
    { name: 'summary', type: 'mdx' },
    { name: 'aside', type: 'mdx', mdxAllow: { components: { Aside: {} } } },
    { name: 'notes', type: 'markdown' },
    { name: 'trusted', type: 'mdx', executable: true },
  ]
  const paths = (data: Record<string, unknown>) =>
    findMarkdownSafetyIssues(schema, 'json', data, site).map((e) => e.fieldPath)

  it('applies to an mdx field, under its own mdxAllow', () => {
    expect(paths({ summary: '<Aside />', aside: '<Aside />' })).toEqual(['summary'])
    expect(paths({ summary: '<Callout />', aside: '<Callout />' })).toEqual(['aside'])
  })

  it('does not reach a markdown or an executable field', () => {
    expect(paths({ notes: '<Aside />', trusted: '<Aside />' })).toEqual([])
  })

  it('applies to the body of an mdx entry with no body field', () => {
    const errors = findMarkdownSafetyIssues([], 'mdx', { body: '<Aside />' }, site)
    expect(errors.map((e) => e.fieldPath)).toEqual(['body'])
  })
})
