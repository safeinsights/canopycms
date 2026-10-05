import { describe, expect, it } from 'vitest'

import {
  PR_SECTION_END,
  PR_SECTION_START,
  appendTrailers,
  buildEditorTrailers,
  buildPrSection,
  mergePrSection,
  sanitizeDisplayName,
  sanitizeEmail,
  sanitizeUserId,
  submissionEditorFromUser,
} from './submission-attribution'
import { ANONYMOUS_USER } from './user'
import { mockConsole } from './test-utils/console-spy'

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
        '**Changed entries (2)**',
        '',
        '- `content/pages/home.md`',
        '- `content/pages/about.md`',
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
