import { describe, expect, it } from 'vitest'
import matter from 'gray-matter'
import { stringify as yamlStringify } from 'yaml'

import { serializeFrontmatter, serializeYaml } from './content-serialize'

/**
 * Shaped like a real adopter entry: a top-of-file block comment, an inline comment on a nested
 * key, and a comment inside a list — including a load-bearing `FLAG:` block of the kind the
 * marketing site's own page code cites by name.
 */
const ADOPTER_YAML = `# Landing page media rail.
# Curated by hand — the CMS list order is the render order.

title: Resources # shown in the hero
intro:
  # FLAG: these post cards are placeholders until the blog ships.
  # src/app/resources/page.tsx cites this block by name — do not delete it.
  heading: Latest from the blog
  blurb: Placeholder copy.
cards:
  # First card is pinned to the top of the rail.
  - Getting started
  - Release notes # updated every Friday
`

const ADOPTER_DATA = {
  title: 'Resources',
  intro: { heading: 'Latest from the blog', blurb: 'Placeholder copy.' },
  cards: ['Getting started', 'Release notes'],
}

describe('serializeYaml', () => {
  it('is byte-identical to a plain stringify when there is no existing file', () => {
    expect(serializeYaml(ADOPTER_DATA)).toBe(yamlStringify(ADOPTER_DATA))
  })

  it('round-trips an unchanged document with every comment intact', () => {
    expect(serializeYaml(ADOPTER_DATA, ADOPTER_YAML)).toBe(ADOPTER_YAML)
  })

  it('keeps every comment when a value elsewhere changes', () => {
    const out = serializeYaml(
      { ...ADOPTER_DATA, intro: { ...ADOPTER_DATA.intro, blurb: 'Real copy now.' } },
      ADOPTER_YAML,
    )
    expect(out).toContain('# Landing page media rail.')
    expect(out).toContain('# FLAG: these post cards are placeholders until the blog ships.')
    expect(out).toContain('# src/app/resources/page.tsx cites this block by name')
    expect(out).toContain('# First card is pinned to the top of the rail.')
    expect(out).toContain('title: Resources # shown in the hero')
    expect(out).toContain('blurb: Real copy now.')
    expect(out).not.toContain('Placeholder copy.')
  })

  it('keeps a trailing comment on the line whose value changed', () => {
    const out = serializeYaml({ ...ADOPTER_DATA, title: 'Guides' }, ADOPTER_YAML)
    expect(out).toContain('title: Guides # shown in the hero')
  })

  it('removes a key the caller dropped, and its value', () => {
    const { title: _title, ...rest } = ADOPTER_DATA
    const out = serializeYaml(rest, ADOPTER_YAML)
    expect(out).not.toContain('title:')
    expect(out).not.toContain('# shown in the hero')
    // Neighbouring comments are untouched by the removal.
    expect(out).toContain('# Landing page media rail.')
    expect(out).toContain('# FLAG: these post cards are placeholders')
  })

  it('appends a key the caller added, after the existing ones', () => {
    const out = serializeYaml({ ...ADOPTER_DATA, subtitle: 'Everything we publish' }, ADOPTER_YAML)
    expect(out).toContain('subtitle: Everything we publish')
    expect(out.indexOf('subtitle:')).toBeGreaterThan(out.indexOf('cards:'))
    expect(out).toContain('# First card is pinned to the top of the rail.')
  })

  it('carries a comment across a value that changes type', () => {
    const out = serializeYaml({ ...ADOPTER_DATA, title: 42 }, ADOPTER_YAML)
    expect(out).toContain('title: 42 # shown in the hero')
    // The number is written as a number, not re-quoted in the old scalar's style.
    expect(out).not.toContain("'42'")
  })

  it('carries list comments with their content across a reorder', () => {
    const out = serializeYaml(
      { ...ADOPTER_DATA, cards: ['Release notes', 'Getting started'] },
      ADOPTER_YAML,
    )
    // The trailing comment travels with "Release notes" rather than staying at index 1.
    expect(out).toContain('- Release notes # updated every Friday')
    expect(out).toContain('- Getting started')
    expect(out).not.toContain('- Getting started # updated every Friday')
  })

  it('appends and truncates list items', () => {
    const appended = serializeYaml(
      { ...ADOPTER_DATA, cards: [...ADOPTER_DATA.cards, 'Changelog'] },
      ADOPTER_YAML,
    )
    expect(appended).toContain('- Changelog')
    expect(appended).toContain('- Release notes # updated every Friday')

    const truncated = serializeYaml({ ...ADOPTER_DATA, cards: ['Getting started'] }, ADOPTER_YAML)
    expect(truncated).not.toContain('Release notes')
    expect(truncated).toContain('# First card is pinned to the top of the rail.')
  })

  it('preserves comments inside a list of objects', () => {
    const raw = `items:
  # The first item is the hero card.
  - label: One
    href: /one
  - label: Two
    href: /two
`
    const out = serializeYaml(
      {
        items: [
          { label: 'One', href: '/uno' },
          { label: 'Two', href: '/two' },
        ],
      },
      raw,
    )
    expect(out).toContain('# The first item is the hero card.')
    expect(out).toContain('href: /uno')
  })

  it('keeps a comment that lives inside a nested object being edited', () => {
    const out = serializeYaml(
      { ...ADOPTER_DATA, intro: { heading: 'Fresh from the blog', blurb: 'Placeholder copy.' } },
      ADOPTER_YAML,
    )
    expect(out).toContain('# FLAG: these post cards are placeholders until the blog ships.')
    expect(out).toContain('heading: Fresh from the blog')
  })

  it('falls back to a plain stringify when the file on disk does not parse', () => {
    const malformed = 'a: [1, 2\nb: 3'
    expect(serializeYaml(ADOPTER_DATA, malformed)).toBe(yamlStringify(ADOPTER_DATA))
  })

  it('empties a document down to {} while keeping its file-level header comment', () => {
    // The header is a document-level comment, not attached to any key, so emptying the data
    // does not orphan it. The body is the same `{}` a plain stringify would produce.
    const out = serializeYaml({}, ADOPTER_YAML)
    expect(out).toContain('# Landing page media rail.')
    expect(out.endsWith(yamlStringify({}))).toBe(true)
    expect(out).not.toContain('title:')
  })

  it('matches a plain stringify for empty data with no comments to keep', () => {
    expect(serializeYaml({}, 'title: Hi\n')).toBe(yamlStringify({}))
  })

  it('keeps a top-of-file comment on a file that had no content yet', () => {
    const out = serializeYaml({ title: 'New' }, '# Written by hand before any save.\n')
    expect(out).toContain('# Written by hand before any save.')
    expect(out).toContain('title: New')
  })

  it('does not let a stale key on disk survive when the caller omits it', () => {
    const raw = 'title: Hi\nlegacySubtitle: gone # with its comment\n'
    const out = serializeYaml({ title: 'Hi' }, raw)
    expect(out).toBe('title: Hi\n')
  })
})

describe('serializeFrontmatter', () => {
  const MD = `---
# Post metadata. Keep \`draft\` first — the build reads it.
draft: false
title: Hello # displayed in the card
tags:
  # Order matters: the first tag is the primary category.
  - guides
  - release
---

Body text here.
`
  const MD_DATA = { draft: false, title: 'Hello', tags: ['guides', 'release'] }

  it('is byte-identical to gray-matter when there is no existing file', () => {
    expect(serializeFrontmatter('\nBody text here.\n', MD_DATA)).toBe(
      matter.stringify('\nBody text here.\n', MD_DATA),
    )
  })

  it('round-trips unchanged frontmatter with every comment intact', () => {
    expect(serializeFrontmatter('\nBody text here.\n', MD_DATA, MD)).toBe(MD)
  })

  it('keeps frontmatter comments when a field and the body both change', () => {
    const out = serializeFrontmatter('\nRewritten body.\n', { ...MD_DATA, title: 'Goodbye' }, MD)
    expect(out).toContain('# Post metadata. Keep `draft` first')
    expect(out).toContain('# Order matters: the first tag is the primary category.')
    expect(out).toContain('title: Goodbye # displayed in the card')
    expect(out).toContain('Rewritten body.')
    expect(out).not.toContain('Body text here.')
    // gray-matter's own framing is unchanged.
    expect(out.startsWith('---\n')).toBe(true)
  })

  it('falls back to gray-matter when the frontmatter on disk does not parse', () => {
    const malformed = '---\na: [1, 2\nb: 3\n---\n\nBody.\n'
    expect(serializeFrontmatter('\nBody.\n', MD_DATA, malformed)).toBe(
      matter.stringify('\nBody.\n', MD_DATA),
    )
  })

  it('falls back to gray-matter for a file with no frontmatter at all', () => {
    expect(serializeFrontmatter('\nBody.\n', MD_DATA, 'Just a body, no delimiters.\n')).toBe(
      matter.stringify('\nBody.\n', MD_DATA),
    )
  })

  it('preserves comments on the SECOND save of the same file', () => {
    // Regression guard: gray-matter's no-options call path reads and writes a process-global
    // content-keyed cache, and the object it returns on a cache HIT has lost `.matter`. Splitting
    // through that path preserved comments on the first save of a file and silently dropped them
    // on every save after — including across different entries that happen to share bytes.
    const first = serializeFrontmatter('\nOne.\n', MD_DATA, MD)
    const second = serializeFrontmatter('\nTwo.\n', MD_DATA, MD)
    expect(first).toContain('# Order matters: the first tag is the primary category.')
    expect(second).toContain('# Order matters: the first tag is the primary category.')
    expect(second).toContain('# Post metadata. Keep `draft` first')
  })
})
