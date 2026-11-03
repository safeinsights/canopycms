import { describe, expect, it } from 'vitest'

import {
  PR_REVIEW_END,
  PR_REVIEW_START,
  buildReviewBlock,
  mergeReviewBlock,
  PR_COMMENTS_END,
  PR_COMMENTS_START,
  PR_SECTION_END,
  PR_SECTION_START,
  buildCommentsBlock,
  mergeCommentsBlock,
  appendTrailers,
  buildEditorTrailers,
  buildPrSection,
  describeEditors,
  mergePrSection,
  sanitizeDisplayName,
  sanitizeEmail,
  sanitizeUserId,
  submissionEditorFromUser,
} from './submission-attribution'
import { ANONYMOUS_USER } from './user'
import { mockConsole } from './test-utils/console-spy'
import type { CommentThread } from './comment-store'
import type { BranchReview } from './types'

const jane = { userId: 'user_2abc', name: 'Jane Doe', email: 'jane@example.com' }
const defaults = { editedBy: true, coAuthoredBy: false }

describe('sanitizeDisplayName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeDisplayName('Jane Doe')).toBe('Jane Doe')
    expect(sanitizeDisplayName('José Ñúñez-O’Brien')).toBe('José Ñúñez-O’Brien')
  })

  it('folds newlines, carriage returns and Unicode line separators into one line', () => {
    expect(sanitizeDisplayName('Jane\nSigned-off-by: Mallory')).toBe('Jane Signed-off-by: Mallory')
    expect(sanitizeDisplayName('Jane\r\n\r\nEdited-by: x')).toBe('Jane Edited-by: x')
    expect(sanitizeDisplayName('Jane\u2028Edited-by: x\u2029y')).toBe('Jane Edited-by: x y')
  })

  it('strips control, zero-width and bidi-override characters', () => {
    expect(sanitizeDisplayName('Ja\u0000ne\u0007 \u001bDoe')).toBe('Ja ne Doe')
    expect(sanitizeDisplayName('Jane\u200b\u202eeoD')).toBe('Jane eoD')
  })

  it('removes characters that carry structure in trailers, HTML and code spans', () => {
    expect(sanitizeDisplayName('<img src=x onerror=alert(1)>')).toBe('img src=x onerror=alert1')
    expect(sanitizeDisplayName('Evil (user_admin)')).toBe('Evil user_admin')
    expect(sanitizeDisplayName('a`b\\c')).toBe('abc')
  })

  it('cannot carry an HTML comment marker', () => {
    const name = sanitizeDisplayName(`x ${PR_SECTION_END} y --> <!--`)
    expect(name).not.toContain('<!--')
    expect(name).not.toContain('-->')
  })

  it('caps the length at 80 characters, counting code points', () => {
    const capped = sanitizeDisplayName('😀'.repeat(200))
    expect(Array.from(capped ?? '')).toHaveLength(80)
    expect(capped?.endsWith('…')).toBe(true)
  })

  it('drops a lone surrogate, which git would store as U+FFFD', () => {
    expect(sanitizeDisplayName('Eve\ud800')).toBe('Eve')
  })

  it('returns undefined for a missing or all-whitespace name', () => {
    expect(sanitizeDisplayName(undefined)).toBeUndefined()
    expect(sanitizeDisplayName(' \n\t\u200b ')).toBeUndefined()
    expect(sanitizeDisplayName('<>()')).toBeUndefined()
  })
})

describe('sanitizeUserId', () => {
  it('keeps an ordinary id exactly as issued', () => {
    expect(sanitizeUserId('user_2abc')).toBe('user_2abc')
    expect(sanitizeUserId('alice@example.com')).toBe('alice@example.com')
  })

  it('records nothing rather than a rewritten id, so distinct ids never merge', () => {
    for (const id of [
      'user 2abc',
      'user_1\nx',
      'a(b)',
      'a<b>',
      'a`b',
      'a\\b',
      'a\u0000b',
      'a\ud800b',
      '',
    ]) {
      expect(sanitizeUserId(id)).toBeUndefined()
    }
    expect(sanitizeUserId('x'.repeat(129))).toBeUndefined()
    expect(sanitizeUserId('x'.repeat(128))).toBe('x'.repeat(128))
  })
})

describe('sanitizeEmail', () => {
  it('accepts a plain single address', () => {
    expect(sanitizeEmail(' jane@example.com ')).toBe('jane@example.com')
  })

  it.each([
    'jane@example.com>\nCo-authored-by: x <y@z.com',
    'Jane <jane@example.com>',
    'a@b@example.com',
    'no-at.example.com',
    'jane@localhost',
    'a\u0000@b.co',
    'a@b.co\u0085x',
    'a\u007f@b.co',
    'a\ud800@b.co',
    '#12@example.com',
    `${'a'.repeat(250)}@example.com`,
  ])('rejects %j', (email) => {
    expect(sanitizeEmail(email)).toBeUndefined()
  })
})

describe('submissionEditorFromUser', () => {
  it('carries id, name and email from an authenticated user', () => {
    expect(
      submissionEditorFromUser({
        type: 'authenticated',
        userId: 'user_2abc',
        groups: [],
        name: 'Jane Doe',
        email: 'jane@example.com',
      }),
    ).toEqual(jane)
  })

  it('records nobody for an anonymous user', () => {
    expect(submissionEditorFromUser(ANONYMOUS_USER)).toBeUndefined()
  })
})

describe('describeEditors', () => {
  it("takes each user's current name and email from the lookup", async () => {
    const lookup = async (id: string) =>
      id === jane.userId ? { id, name: jane.name, email: jane.email } : null

    expect(await describeEditors([jane.userId, 'user_gone'], lookup)).toEqual([
      jane,
      { userId: 'user_gone' },
    ])
  })

  it('drops a looked-up name that is blank or the id itself', async () => {
    const lookup = async (id: string) => ({
      id,
      name: id === 'user_x' ? 'user_x' : ' ',
      email: 'x@x.test',
    })

    expect(await describeEditors(['user_x', 'user_y'], lookup)).toEqual([
      { userId: 'user_x', name: undefined, email: 'x@x.test' },
      { userId: 'user_y', name: undefined, email: 'x@x.test' },
    ])
  })

  it('keeps just the id without a lookup, or when the lookup throws', async () => {
    expect(await describeEditors([jane.userId], undefined)).toEqual([{ userId: jane.userId }])

    const consoleSpy = mockConsole()
    const failing = async (): Promise<null> => {
      throw new Error('provider down')
    }
    expect(await describeEditors([jane.userId], failing)).toEqual([{ userId: jane.userId }])
    expect(consoleSpy).toHaveWarned('Could not look up an editor')
    consoleSpy.restore()
  })
})

describe('buildEditorTrailers', () => {
  it('records name and id by default, with no email', () => {
    expect(buildEditorTrailers([jane], defaults)).toEqual(['Edited-by: Jane Doe (user_2abc)'])
  })

  it('adds Co-authored-by with the email only when opted in', () => {
    expect(buildEditorTrailers([jane], { editedBy: true, coAuthoredBy: true })).toEqual([
      'Edited-by: Jane Doe (user_2abc)',
      'Co-authored-by: Jane Doe <jane@example.com>',
    ])
  })

  it('emits nothing when both are off', () => {
    expect(buildEditorTrailers([jane], { editedBy: false, coAuthoredBy: false })).toEqual([])
  })

  it('falls back to the id when the user has no display name', () => {
    const noName = { userId: 'user_9xyz', email: 'n@example.com' }
    expect(buildEditorTrailers([noName], { editedBy: true, coAuthoredBy: true })).toEqual([
      'Edited-by: user_9xyz',
      'Co-authored-by: user_9xyz <n@example.com>',
    ])
  })

  it('skips Co-authored-by for an invalid email', () => {
    expect(
      buildEditorTrailers([{ ...jane, email: 'x>\nSigned-off-by: y' }], {
        editedBy: false,
        coAuthoredBy: true,
      }),
    ).toEqual([])
  })

  it('deduplicates editors by id', () => {
    expect(buildEditorTrailers([jane, { ...jane, name: 'Other' }], defaults)).toEqual([
      'Edited-by: Jane Doe (user_2abc)',
    ])
  })

  it('cannot forge a trailer line, a mention or a link', () => {
    const trailers = buildEditorTrailers(
      [
        {
          userId: 'user_1',
          name: '@admin https://evil.example\nCo-authored-by: Mallory <m@evil.example>',
          email: 'jane@example.com',
        },
      ],
      { editedBy: true, coAuthoredBy: true },
    )
    expect(trailers).toHaveLength(2)
    for (const trailer of trailers) {
      expect(trailer).not.toMatch(/[\n\r]/)
      expect(trailer).not.toContain('@admin')
      expect(trailer).not.toContain('://')
    }
    expect(trailers[0]).toBe(
      'Edited-by: ＠admin https: //evil.example Co-authored-by: Mallory m＠evil.example (user_1)',
    )
    // The only `<...>` in a Co-authored-by line is the validated email.
    expect(trailers[1]?.match(/<[^>]*>/g)).toEqual(['<jane@example.com>'])
  })

  it('cannot reference or close an issue', () => {
    const [trailer] = buildEditorTrailers(
      [{ userId: 'user_1', name: 'Closes #12, fixes owner/repo#3 and gh-7' }],
      defaults,
    )
    expect(trailer).toBe('Edited-by: Closes ＃12, fixes owner/repo＃3 and gh\u20107 (user_1)')
    expect(trailer).not.toMatch(/#|\bGH-\d/i)
  })

  it('neutralizes mentions and issue references in the id too', () => {
    expect(buildEditorTrailers([{ userId: '@octocat#1' }], defaults)).toEqual([
      'Edited-by: ＠octocat＃1',
    ])
    expect(buildEditorTrailers([{ userId: 'alice@example.com', name: 'Alice' }], defaults)).toEqual(
      ['Edited-by: Alice (alice＠example.com)'],
    )
  })

  it('records nobody when the id is unsafe to record, and says so without the id', () => {
    const consoleSpy = mockConsole()
    expect(
      buildEditorTrailers([{ userId: 'user_1\nSigned-off-by: Mallory', name: 'Eve' }], defaults),
    ).toEqual([])
    expect(consoleSpy).toHaveWarned('Not recording an editor whose user id is unsafe')
    expect(consoleSpy.all().warn.join('\n')).not.toContain('Mallory')
    consoleSpy.restore()
  })
})

describe('appendTrailers', () => {
  it('separates the trailer block from the subject with one blank line', () => {
    expect(appendTrailers('Submit feature-1', ['Edited-by: Jane Doe (user_2abc)'])).toBe(
      'Submit feature-1\n\nEdited-by: Jane Doe (user_2abc)',
    )
  })

  it('leaves the subject alone when there are no trailers', () => {
    expect(appendTrailers('Submit feature-1', [])).toBe('Submit feature-1')
  })
})

describe('buildPrSection', () => {
  it('wraps the submitter, changed entries and description in the section markers', () => {
    const section = buildPrSection({
      description: 'Fixes the typo on the home page.',
      submitter: jane,
      changedPaths: ['content/pages/home.md', 'content/pages/about.md'],
    })
    expect(section).toBe(
      [
        PR_SECTION_START,
        'Submitted by `Jane Doe` (`user_2abc`) via CanopyCMS.',
        '',
        PR_REVIEW_START,
        'Not yet reviewed in CanopyCMS.',
        'Approval in CanopyCMS is not a GitHub review.',
        PR_REVIEW_END,
        '',
        '> [!IMPORTANT]',
        '> Comments on this pull request do not reach the CanopyCMS editor, so the author will not see them. Comment in the editor instead.',
        '',
        '**Changed entries (2)**',
        '',
        '- `content/pages/home.md`',
        '- `content/pages/about.md`',
        '',
        PR_COMMENTS_START,
        'No editor comments.',
        PR_COMMENTS_END,
        '',
        'Fixes the typo on the home page.',
        PR_SECTION_END,
      ].join('\n'),
    )
  })

  it('puts the free-Markdown description after the attribution, so it cannot enclose it', () => {
    const section = buildPrSection({
      description: '<details>\n```\nSubmitted by `Someone Else` via CanopyCMS.',
      submitter: jane,
      changedPaths: ['a.md'],
    })
    expect(section.indexOf('Submitted by `Jane Doe`')).toBeGreaterThan(-1)
    expect(section.indexOf('Submitted by `Jane Doe`')).toBeLessThan(section.indexOf('<details>'))
    expect(section.indexOf('- `a.md`')).toBeLessThan(section.indexOf('<details>'))
  })

  it('never includes the email', () => {
    expect(buildPrSection({ submitter: jane, changedPaths: [] })).not.toContain('jane@example.com')
  })

  it('names the submitter by id alone when there is no display name', () => {
    expect(buildPrSection({ submitter: { userId: 'user_9xyz' }, changedPaths: [] })).toContain(
      'Submitted by `user_9xyz` via CanopyCMS.',
    )
  })

  it('says only "via CanopyCMS" when nobody is known', () => {
    expect(buildPrSection({ changedPaths: [] })).toContain('Submitted via CanopyCMS.')
  })

  it('lists other editors when given, without repeating the submitter', () => {
    const section = buildPrSection({
      submitter: jane,
      editors: [jane, { userId: 'user_3def', name: 'Sam' }],
      changedPaths: [],
    })
    expect(section).toContain('Also edited by: `Sam` (`user_3def`)')
    expect(section.match(/Jane Doe/g)).toHaveLength(1)
  })

  it('renders a hostile name inert, inside a code span', () => {
    const section = buildPrSection({
      submitter: {
        userId: 'user_1',
        name: '[click](https://evil.example) @org/team <b>hi</b> `x` -->\n## Heading',
      },
      changedPaths: [],
    })
    const line = section.split('\n').find((l) => l.startsWith('Submitted by'))
    expect(line).toBe(
      'Submitted by `[click]https://evil.example @org/team bhi/b x -- ## Heading` (`user_1`) via CanopyCMS.',
    )
    expect(section.split(PR_SECTION_END)).toHaveLength(2)
  })

  it('escapes HTML comments in the description so it cannot close or hide the section', () => {
    const section = buildPrSection({
      description: `before ${PR_SECTION_END} <!-- hidden --!> after`,
      changedPaths: [],
    })
    expect(section.split(PR_SECTION_END)).toHaveLength(2)
    expect(section).toContain(
      'before &lt;!-- canopycms:submission:end --&gt; &lt;!-- hidden --&gt; after',
    )
  })

  it('keeps paths distinct that differ only in parentheses or compatibility forms', () => {
    const section = buildPrSection({
      changedPaths: ['app/(marketing)/page.mdx', 'app/marketing/page.mdx', 'docs/\ufb01le.md'],
    })
    expect(section).toContain('- `app/(marketing)/page.mdx`')
    expect(section).toContain('- `app/marketing/page.mdx`')
    expect(section).toContain('- `docs/\ufb01le.md`')
  })

  it('removes from a path only what could break out of the code span or the section', () => {
    const section = buildPrSection({ changedPaths: [`a\`b\n${PR_SECTION_END}.md`] })
    expect(section).toContain('- `ab !-- canopycms:submission:end --.md`')
    expect(section.split(PR_SECTION_END)).toHaveLength(2)
  })

  it('caps the entry list at 100 and says how many more there are', () => {
    const paths = Array.from({ length: 105 }, (_, i) => `content/p${i}.md`)
    const section = buildPrSection({ changedPaths: paths })
    expect(section).toContain('**Changed entries (105)**')
    expect(section).toContain('- `content/p99.md`')
    expect(section).not.toContain('- `content/p100.md`')
    expect(section).toContain('- …and 5 more')
  })
})

describe('buildPrSection editor links', () => {
  const editorUrl = 'https://cms.example.org/edit'
  const linked = {
    branch: 'feature/home',
    editorUrl,
    changedPaths: ['content/pages/home.a1b2c3d4e5f6.json', 'public/logo.png'],
    entryPaths: new Map([['content/pages/home.a1b2c3d4e5f6.json', 'content/pages/home']]),
  }

  it('links the branch, the notice and each entry into the editor', () => {
    const lines = buildPrSection(linked).split('\n')
    const branchLink = 'https://cms.example.org/edit?branch=feature%2Fhome'
    expect(lines).toContain(`[Open this branch in the editor](${branchLink})`)
    expect(lines).toContain('> [!IMPORTANT]')
    expect(lines).toContain(
      `> Comments on this pull request do not reach the CanopyCMS editor, so the author will not see them. Comment in the [editor](${branchLink}) instead.`,
    )
    expect(lines).toContain(
      `- \`content/pages/home.a1b2c3d4e5f6.json\` ([open in editor](${branchLink}&entry=content%2Fpages%2Fhome))`,
    )
    expect(lines).toContain('- `public/logo.png`')
  })

  it('keeps the notice but drops every link without an editor URL or a branch', () => {
    for (const input of [
      { ...linked, editorUrl: undefined },
      { ...linked, branch: undefined },
    ]) {
      const section = buildPrSection(input)
      expect(section).toContain('> [!IMPORTANT]')
      expect(section).not.toContain('](')
      expect(section).toContain('- `content/pages/home.a1b2c3d4e5f6.json`\n')
    }
  })

  it('keeps hostile branch and entry names inside the link destination', () => {
    const section = buildPrSection({
      ...linked,
      editorUrl: "https://cms.example.org/a(b)/[c]/d'e",
      branch: 'x) [y](https://evil.example "t") <b>',
      entryPaths: new Map([
        ['content/pages/home.a1b2c3d4e5f6.json', `content/p) ${PR_SECTION_END}\n# h`],
      ]),
    })
    const links = [...section.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1])
    expect(links).toHaveLength(3)
    for (const href of links) {
      expect(href).toMatch(/^https:\/\/cms\.example\.org\/a%28b%29\/\[c\]\/d%27e\?branch=/)
      expect(href).not.toMatch(/[\s()<>'"\\`]/)
    }
    expect(section.split(PR_SECTION_END)).toHaveLength(2)
    expect(section).not.toContain('<b>')
  })
})

describe('buildPrSection length', () => {
  it('keeps the brackets of an IPv6 editor host', () => {
    const section = buildPrSection({
      branch: 'b',
      editorUrl: 'http://[::1]:3000/edit',
      changedPaths: [],
    })
    expect(section).toContain('[Open this branch in the editor](http://[::1]:3000/edit?branch=b)')
  })

  it('drops the entry links, not the entries, when they would make the body too long', () => {
    const paths = Array.from({ length: 100 }, (_, i) => `content/${'d'.repeat(250)}/p${i}.json`)
    const input = {
      branch: 'feature/x',
      editorUrl: `https://cms.example.org/${'e'.repeat(500)}`,
      changedPaths: paths,
      entryPaths: new Map(paths.map((p) => [p, p.replace('.json', '')])),
      description: 'x'.repeat(20_000),
    }
    const section = buildPrSection(input)
    expect(section.length).toBeLessThan(65_536)
    expect(section).toContain(`- \`${paths[99]}\`\n`)
    expect(section).not.toContain('open in editor')
    expect(section).toContain('[Open this branch in the editor]')
    // A short list keeps its links.
    expect(buildPrSection({ ...input, changedPaths: paths.slice(0, 3) })).toContain(
      'open in editor',
    )
  })

  it('cuts the end of the description next, keeping every listed entry', () => {
    const paths = Array.from({ length: 80 }, (_, i) => `content/${'d'.repeat(280)}/p${i}.json`)
    // Neutralizing doubles `-->`, so 10,000 characters of it write 20,000.
    const section = buildPrSection({ changedPaths: paths, description: '-->'.repeat(3333) })
    expect(section.length).toBeLessThanOrEqual(45_000)
    expect(section).toContain(`- \`${paths[79]}\`\n`)
    expect(section).toMatch(/…\n<!-- canopycms:submission:end -->$/)
    expect(section).toContain('--&gt;--&gt;')
  })

  it('lists fewer entries, dropping the description, when the list alone is too long', () => {
    const paths = Array.from({ length: 100 }, (_, i) => `content/${'\u{1F600}'.repeat(298)}${i}`)
    const section = buildPrSection({ changedPaths: paths, description: 'Desc' })
    expect(section.length).toBeLessThanOrEqual(45_000)
    expect(section).toContain('**Changed entries (100)**')
    expect(section).toMatch(/- …and \d+ more\n\n<!-- canopycms:comments:start -->/)
    expect(section).not.toContain('Desc')
  })
})

describe('mergePrSection', () => {
  const oldSection = `${PR_SECTION_START}\nold\n${PR_SECTION_END}`
  const newSection = `${PR_SECTION_START}\nnew\n${PR_SECTION_END}`

  it('is the section alone for an empty or missing body', () => {
    expect(mergePrSection(undefined, newSection)).toBe(newSection)
    expect(mergePrSection(null, newSection)).toBe(newSection)
    expect(mergePrSection('  \n', newSection)).toBe(newSection)
  })

  it('replaces only the section, keeping human text before and after it byte for byte', () => {
    const existing = `Reviewer note: looks good\n\n${oldSection}\n\nCloses #12\n`
    expect(mergePrSection(existing, newSection)).toBe(
      `Reviewer note: looks good\n\n${newSection}\n\nCloses #12\n`,
    )
  })

  it('appends the section after a body that has none', () => {
    expect(mergePrSection('Hand-written description', newSection)).toBe(
      `Hand-written description\n\n${newSection}`,
    )
  })

  it('drops stray markers from a damaged section and appends a fresh one', () => {
    expect(mergePrSection(`notes\n${PR_SECTION_START}\nold`, newSection)).toBe(
      `notes\n\nold\n\n${newSection}`,
    )
    expect(mergePrSection(`old\n${PR_SECTION_END}\nnotes`, newSection)).toBe(
      `old\n\nnotes\n\n${newSection}`,
    )
  })

  it('ignores a start marker a human quoted earlier in the body', () => {
    const existing = [
      'Intro',
      '```',
      PR_SECTION_START,
      '```',
      'Human text that must survive',
      oldSection,
      'Outro',
    ].join('\n')
    expect(mergePrSection(existing, newSection)).toBe(
      [
        'Intro',
        '```',
        PR_SECTION_START,
        '```',
        'Human text that must survive',
        newSection,
        'Outro',
      ].join('\n'),
    )
  })

  it('ignores an end marker a human quoted before the section', () => {
    const existing = `quoted ${PR_SECTION_END} here\n\n${oldSection}\n\nOutro`
    expect(mergePrSection(existing, newSection)).toBe(
      `quoted ${PR_SECTION_END} here\n\n${newSection}\n\nOutro`,
    )
  })

  it('round-trips: merging a freshly built section twice changes nothing more', () => {
    const section = buildPrSection({ submitter: jane, changedPaths: ['a.md'] })
    const once = mergePrSection('Human text', section)
    expect(mergePrSection(once, section)).toBe(once)
  })
})

describe('buildCommentsBlock', () => {
  const editorUrl = 'https://cms.example.org/edit'
  let n = 0
  const thread = (overrides: Partial<CommentThread> & { text?: string } = {}): CommentThread => {
    n++
    const { text = `Comment ${n}`, ...rest } = overrides
    return {
      id: `t${n}`,
      comments: [{ id: `c${n}`, threadId: `t${n}`, userId: 'u1', timestamp: '', text }],
      resolved: false,
      createdAt: `2026-10-0${n % 9}T00:00:00Z`,
      type: 'entry',
      authorId: 'u1',
      entryPath: 'content/pages/home',
      ...rest,
    }
  }
  const lines = (block: string) => block.split('\n')

  it('lists each unresolved thread with its place, first line and editor link', () => {
    const block = buildCommentsBlock(
      [
        thread({ text: 'Fix the intro\nand more detail below' }),
        thread({ type: 'field', canopyPath: 'blocks[0].title', text: 'Too long' }),
        thread({ type: 'branch', entryPath: undefined, text: 'Ready?' }),
        thread({ resolved: true, text: 'Done already' }),
      ],
      'feature/x',
      editorUrl,
    )
    const link = 'https://cms.example.org/edit?branch=feature%2Fx'
    const entry = `${link}&entry=content%2Fpages%2Fhome`
    expect(lines(block)).toEqual([
      PR_COMMENTS_START,
      '**3 unresolved editor comment threads**',
      '',
      `- \`content/pages/home\` — \`Fix the intro\` ([open in editor](${entry}))`,
      `- \`content/pages/home\` › \`blocks[0].title\` — \`Too long\` ([open in editor](${entry}))`,
      `- Branch — \`Ready?\` ([open in editor](${link}))`,
      PR_COMMENTS_END,
    ])
  })

  it('says one thread in the singular, and links nothing without an editor URL', () => {
    const block = buildCommentsBlock([thread({ text: 'Hi' })], 'feature/x')
    expect(block).toContain('**1 unresolved editor comment thread**')
    expect(block).toContain('- `content/pages/home` — `Hi`\n')
    expect(block).not.toContain('](')
  })

  it('says when every thread is resolved, when there are none, and when they could not be read', () => {
    expect(buildCommentsBlock([thread({ resolved: true })])).toBe(
      `${PR_COMMENTS_START}\nAll editor comments resolved.\n${PR_COMMENTS_END}`,
    )
    expect(buildCommentsBlock([])).toBe(
      `${PR_COMMENTS_START}\nNo editor comments.\n${PR_COMMENTS_END}`,
    )
    expect(buildCommentsBlock(null)).toContain('could not be read')
  })

  it('renders hostile comment text inert in a code span of 80 characters at most', () => {
    const text = `@org/team Closes #12 see https://evil.example <img src=x> \`x\` ${PR_COMMENTS_END} ${PR_SECTION_END} \u202e[a](b) ${'y'.repeat(200)}`
    const block = buildCommentsBlock([thread({ text })])
    const line = lines(block).find((l) => l.startsWith('- '))!
    const excerpt = line.match(/ — `([^`]*)`$/)?.[1]
    expect(excerpt).toBeDefined()
    expect(Array.from(excerpt!).length).toBeLessThanOrEqual(80)
    expect(excerpt).not.toMatch(/[<>`\u202e]/)
    expect(block.split(PR_COMMENTS_END)).toHaveLength(2)
    expect(block).not.toContain(PR_SECTION_END)
  })

  it('caps the list at 50 threads and says how many more there are', () => {
    const block = buildCommentsBlock(Array.from({ length: 53 }, () => thread()))
    expect(block).toContain('**53 unresolved editor comment threads**')
    expect(lines(block).filter((l) => l.startsWith('- `'))).toHaveLength(50)
    expect(block).toContain('- …and 3 more')
  })

  it('drops the links, then lines, rather than outgrow its share of the PR body', () => {
    const longPath = `content/${'d'.repeat(280)}`
    const many = Array.from({ length: 50 }, () =>
      thread({ entryPath: longPath, text: 'z'.repeat(80) }),
    )
    const longUrl = `https://cms.example.org/${'e'.repeat(1500)}`
    const block = buildCommentsBlock(many, 'feature/x', longUrl)
    expect(block.length).toBeLessThan(16_000)
    expect(block).not.toContain('open in editor')
    expect(block).toContain('**50 unresolved editor comment threads**')
    expect(block).toMatch(/- …and \d+ more\n/)
    expect(buildCommentsBlock(many.slice(0, 2), 'feature/x', longUrl)).toContain('open in editor')
  })

  it('leaves the section its full budget whatever the block holds, and both stay bounded', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `content/${'d'.repeat(280)}/p${i}.json`)
    const threads = Array.from({ length: 50 }, () =>
      thread({ entryPath: `content/${'d'.repeat(280)}`, text: 'z'.repeat(80) }),
    )
    const input = { changedPaths: paths, description: 'x'.repeat(5_000), branch: 'f' }
    const bare = buildPrSection(input)
    const withBlock = buildPrSection({ ...input, threads })
    // The description is not cut to make room for the block.
    expect(withBlock).toContain('x'.repeat(5_000))
    expect(withBlock.length).toBeLessThan(45_500)
    expect(bare.length).toBeLessThan(31_000)
    // At its largest the section's own text keeps to 30,000, leaving the block its 15,000.
    const largest = buildPrSection({
      changedPaths: Array.from({ length: 100 }, (_, i) => `content/${'d'.repeat(280)}/q${i}.json`),
      description: 'y'.repeat(10_000),
      threads,
      branch: 'f',
    })
    expect(largest.length).toBeLessThan(45_500)
  })

  it('survives malformed threads from the unvalidated comments.json', () => {
    const malformed = [
      null,
      'a string',
      { resolved: false },
      thread({ entryPath: '../../etc', text: 'x' }),
      thread({ entryPath: 'content/a\nb', comments: 'nope' as unknown as [] }),
    ] as unknown as CommentThread[]
    const block = buildCommentsBlock(malformed, 'f', editorUrl)
    expect(block).toContain('**3 unresolved editor comment threads**')
    expect(block).toContain('- An entry\n')
    expect(block).toContain('- An entry — `x`\n')
    expect(block).not.toContain('entry=')
  })
})

describe('mergeCommentsBlock', () => {
  const section = buildPrSection({ changedPaths: ['a.md'], description: 'Desc' })
  const block = `${PR_COMMENTS_START}\nAll editor comments resolved.\n${PR_COMMENTS_END}`

  it('replaces only the block inside the section, keeping the human text around it', () => {
    const body = `Reviewer notes\n\n${section}\n\nMore notes`
    const merged = mergeCommentsBlock(body, block)
    expect(merged).toBe(
      body.replace(`${PR_COMMENTS_START}\nNo editor comments.\n${PR_COMMENTS_END}`, block),
    )
    expect(merged).toContain('Reviewer notes')
    expect(merged).toContain('Desc')
    expect(mergeCommentsBlock(merged, block)).toBe(merged)
  })

  it('ignores comment markers a human quoted outside the section', () => {
    const body = `quoted ${PR_COMMENTS_START} x ${PR_COMMENTS_END}\n\n${section}`
    const merged = mergeCommentsBlock(body, block)!
    expect(merged.startsWith(`quoted ${PR_COMMENTS_START} x ${PR_COMMENTS_END}`)).toBe(true)
    expect(merged).toContain('All editor comments resolved.')
  })

  it('is undefined without a section, or a section without the block', () => {
    expect(mergeCommentsBlock('just text', block)).toBeUndefined()
    expect(mergeCommentsBlock(null, block)).toBeUndefined()
    const legacy = `${PR_SECTION_START}\nSubmitted via CanopyCMS.\n${PR_SECTION_END}`
    expect(mergeCommentsBlock(legacy, block)).toBeUndefined()
    // A block after the section is not inside it.
    expect(mergeCommentsBlock(`${legacy}\n${block}`, block)).toBeUndefined()
  })

  it('puts the block before the free-Markdown description in a built section', () => {
    expect(section.indexOf(PR_COMMENTS_END)).toBeLessThan(section.indexOf('Desc'))
  })
})

describe('buildReviewBlock', () => {
  describe('files whose GitHub change was left out', () => {
    it('lists none when there are none', () => {
      expect(buildReviewBlock(undefined, [])).toBe(buildReviewBlock(undefined))
    })

    it('lists each path inside the block, so a re-render replaces the list too', () => {
      const block = buildReviewBlock(undefined, ['content/a.json', 'content/b.json'])
      expect(block).toContain("The editor's version was kept")
      expect(block).toContain('- `content/a.json`\n- `content/b.json`')
      expect(block.endsWith(PR_REVIEW_END)).toBe(true)
    })

    it('cannot close the block or a code span from a path, which comes from a commit', () => {
      const block = buildReviewBlock(undefined, ['content/`x`<!-- canopycms:review:end -->.json'])
      expect(block.split(PR_REVIEW_END)).toHaveLength(2)
      expect(block).toContain('- `content/x!-- canopycms:review:end --.json`')
    })

    it('bounds a long list', () => {
      const paths = Array.from({ length: 25 }, (_, i) => `content/${i}.json`)
      const block = buildReviewBlock(undefined, paths)
      expect(block).toContain('- `content/19.json`')
      expect(block).not.toContain('- `content/20.json`')
      expect(block).toContain('...and 5 more')
    })
  })

  const at = '2026-10-28T14:05:59.123Z'
  const NOT_GITHUB = 'Approval in CanopyCMS is not a GitHub review.'

  it('says a branch with no review is not yet reviewed', () => {
    expect(buildReviewBlock(undefined)).toBe(
      [PR_REVIEW_START, 'Not yet reviewed in CanopyCMS.', NOT_GITHUB, PR_REVIEW_END].join('\n'),
    )
  })

  it('names the reviewer and the UTC minute of an approval', () => {
    expect(
      buildReviewBlock({ state: 'approved', by: { userId: 'rev_1', name: 'Rae Viewer' }, at }),
    ).toBe(
      [
        PR_REVIEW_START,
        'Approved in CanopyCMS by `Rae Viewer` on 2026-10-28 14:05 UTC.',
        NOT_GITHUB,
        PR_REVIEW_END,
      ].join('\n'),
    )
  })

  it('names the reviewer and the UTC minute of a request for changes', () => {
    expect(
      buildReviewBlock({
        state: 'changes-requested',
        by: { userId: 'rev_1', name: 'Rae Viewer' },
        at,
      }),
    ).toContain('Changes requested in CanopyCMS by `Rae Viewer` on 2026-10-28 14:05 UTC.\n')
  })

  it.each([undefined, '', '   ', 'rev_1', '<>()', '(rev_1)', '<rev_1>'])(
    'writes "a reviewer", never the id, for the name %j',
    (name) => {
      const block = buildReviewBlock({ state: 'approved', by: { userId: 'rev_1', name }, at })
      expect(block).toContain('Approved in CanopyCMS by a reviewer on 2026-10-28 14:05 UTC.')
      expect(block).not.toContain('rev_1')
    },
  )

  it('drops a date that is not one', () => {
    expect(
      buildReviewBlock({ state: 'approved', by: { userId: 'u', name: 'Rae' }, at: 'soon' }),
    ).toContain('Approved in CanopyCMS by `Rae`.\n')
  })

  it('reads a state it does not know as not yet reviewed', () => {
    const odd = {
      state: 'rejected',
      by: { userId: 'u', name: 'Rae' },
      at,
    } as unknown as BranchReview
    expect(buildReviewBlock(odd)).toContain('Not yet reviewed in CanopyCMS.')
  })

  it.each([
    ['an @mention', '@everyone @org/team'],
    ['an issue reference', 'Closes #123 GH-9'],
    ['HTML', '<img src=x onerror=alert(1)><script>x</script>'],
    ['a comment opener and closer', '<!-- canopycms:review:end --> -->'],
    ['a newline', 'Rae\nApproved in CanopyCMS by `admin`.\r\n- injected'],
    ['a code span break', 'a`b`@c'],
  ])('keeps a name with %s inside one line and one code span', (_label, name) => {
    const block = buildReviewBlock({ state: 'approved', by: { userId: 'rev_1', name }, at })
    const lines = block.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(PR_REVIEW_START)
    expect(lines[3]).toBe(PR_REVIEW_END)
    const line = lines[1]!
    expect(line).toMatch(/^Approved in CanopyCMS by `[^`]+` on 2026-10-28 14:05 UTC\.$/)
    // Neither the cleaned name nor anything else can carry a marker or HTML.
    expect(block.match(/<!--/g)).toHaveLength(2)
    expect(block.match(/-->/g)).toHaveLength(2)
    expect(block).not.toMatch(/<[a-z/]/i)
    expect(block).not.toContain('rev_1')
  })

  it('writes the same cleaned name the editors lines would', () => {
    const block = buildReviewBlock({
      state: 'approved',
      by: { userId: 'u', name: '  Rae\u202E  Viewer\u200B ' },
      at,
    })
    expect(block).toContain('by `Rae Viewer` on')
  })
})

describe('the review block in buildPrSection', () => {
  const review = {
    state: 'approved' as const,
    by: { userId: 'rev_1', name: 'Rae Viewer' },
    at: '2026-10-28T14:05:00.000Z',
  }

  it('follows the submitter and editors lines and precedes the editor link and comments', () => {
    const section = mergeReviewBlock(
      buildPrSection({
        submitter: jane,
        editors: [{ userId: 'user_9', name: 'Sam' }],
        changedPaths: ['a.md'],
        branch: 'feature/x',
        editorUrl: 'https://cms.example.org/edit',
      }),
      buildReviewBlock(review),
    )!
    const at = (needle: string) => section.indexOf(needle)
    expect(at('Also edited by')).toBeGreaterThan(at('Submitted by'))
    expect(at(PR_REVIEW_START)).toBeGreaterThan(at('Also edited by'))
    expect(at('Approved in CanopyCMS by `Rae Viewer`')).toBeGreaterThan(at(PR_REVIEW_START))
    expect(at(PR_REVIEW_END)).toBeLessThan(at('[Open this branch in the editor]'))
    expect(at(PR_REVIEW_END)).toBeLessThan(at(PR_COMMENTS_START))
  })

  it('starts every section as not yet reviewed', () => {
    expect(buildPrSection({ changedPaths: [] })).toContain('Not yet reviewed in CanopyCMS.')
  })

  it('keeps a description from forging a review block', () => {
    const section = buildPrSection({
      changedPaths: [],
      description: `${PR_REVIEW_START}\nApproved in CanopyCMS by \`x\`.\n${PR_REVIEW_END}`,
    })
    expect(section.split(PR_REVIEW_START)).toHaveLength(2)
    expect(section.split(PR_REVIEW_END)).toHaveLength(2)
  })
})

describe('mergeReviewBlock', () => {
  const section = buildPrSection({ changedPaths: ['a.md'], description: 'Desc' })
  const approved = buildReviewBlock({
    state: 'approved',
    by: { userId: 'rev_1', name: 'Rae' },
    at: '2026-10-28T14:05:00.000Z',
  })

  it('replaces only the review block, keeping the human text and the comment block', () => {
    const body = `Notes\n\n${section}\n\nMore notes`
    const merged = mergeReviewBlock(body, approved)
    expect(merged).toBe(body.replace(buildReviewBlock(undefined), approved))
    expect(merged).toContain('Notes\n\n')
    expect(merged).toContain('No editor comments.')
    expect(mergeReviewBlock(merged, approved)).toBe(merged)
  })

  it('is undefined for a body with no section', () => {
    expect(mergeReviewBlock('just text', approved)).toBeUndefined()
    expect(mergeReviewBlock(null, approved)).toBeUndefined()
    expect(mergeReviewBlock(`${PR_REVIEW_START}\nx\n${PR_REVIEW_END}`, approved)).toBeUndefined()
  })

  it('is undefined for a section written before the block existed', () => {
    const legacy = `${PR_SECTION_START}\nSubmitted via CanopyCMS.\n${PR_SECTION_END}`
    expect(mergeReviewBlock(legacy, approved)).toBeUndefined()
    // A block after the section is not inside it.
    expect(mergeReviewBlock(`${legacy}\n${approved}`, approved)).toBeUndefined()
  })

  it('ignores review markers a human quoted outside the section', () => {
    const body = `quoted ${PR_REVIEW_START} x ${PR_REVIEW_END}\n\n${section}`
    const merged = mergeReviewBlock(body, approved)!
    expect(merged.startsWith(`quoted ${PR_REVIEW_START} x ${PR_REVIEW_END}`)).toBe(true)
    expect(merged).toContain('Approved in CanopyCMS by `Rae`')
  })
})
