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
    expect(sanitizeDisplayName('Jane Edited-by: x y')).toBe('Jane Edited-by: x y')
  })

  it('strips control, zero-width and bidi-override characters', () => {
    expect(sanitizeDisplayName('Ja\u0000ne\u0007 \u001bDoe')).toBe('Ja ne Doe')
    expect(sanitizeDisplayName('Jane​‮eoD')).toBe('Jane eoD')
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

  it('returns undefined for a missing or all-whitespace name', () => {
    expect(sanitizeDisplayName(undefined)).toBeUndefined()
    expect(sanitizeDisplayName(' \n\t​ ')).toBeUndefined()
    expect(sanitizeDisplayName('<>()')).toBeUndefined()
  })
})

describe('sanitizeUserId', () => {
  it('removes whitespace entirely', () => {
    expect(sanitizeUserId('user_2abc')).toBe('user_2abc')
    expect(sanitizeUserId('user 2\nabc')).toBe('user2abc')
  })

  it('returns undefined when nothing survives', () => {
    expect(sanitizeUserId('\n')).toBeUndefined()
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
          userId: 'user_1\nSigned-off-by: Mallory',
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
      'Edited-by: ＠admin https: //evil.example Co-authored-by: Mallory m＠evil.example (user_1Signed-off-by:Mallory)',
    )
    // The only `<...>` in a Co-authored-by line is the validated email.
    expect(trailers[1]?.match(/<[^>]*>/g)).toEqual(['<jane@example.com>'])
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
  it('wraps the description, submitter and changed entries in the section markers', () => {
    const section = buildPrSection({
      description: 'Fixes the typo on the home page.',
      submitter: jane,
      changedPaths: ['content/pages/home.md', 'content/pages/about.md'],
    })
    expect(section).toBe(
      [
        PR_SECTION_START,
        'Fixes the typo on the home page.',
        '',
        'Submitted by `Jane Doe` (`user_2abc`) via CanopyCMS.',
        '',
        '**Changed entries (2)**',
        '',
        '- `content/pages/home.md`',
        '- `content/pages/about.md`',
        PR_SECTION_END,
      ].join('\n'),
    )
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

  it('round-trips: merging a freshly built section twice changes nothing more', () => {
    const section = buildPrSection({ submitter: jane, changedPaths: ['a.md'] })
    const once = mergePrSection('Human text', section)
    expect(mergePrSection(once, section)).toBe(once)
  })
})
