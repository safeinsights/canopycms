import { describe, expect, it } from 'vitest'
import matter from 'gray-matter'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

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

  it('serialises a Date as a timestamp even when a map is currently in that slot', () => {
    // A class instance is not a record. Walking its (empty) own keys emitted `{}` and silently
    // replaced the value -- the one way a write could corrupt content rather than just lose a
    // comment. Reachable from server-side callers (build scripts, migrations), not from HTTP.
    const iso = '2024-01-15T00:00:00.000Z'
    expect(serializeYaml({ d: new Date(iso) }, 'd:\n  x: 1\n')).toBe(
      yamlStringify({ d: new Date(iso) }),
    )
    expect(serializeYaml({ d: new Date(iso) }, 'd: 1\n')).toBe(yamlStringify({ d: new Date(iso) }))
  })

  it('omits an explicitly-undefined key rather than writing null over the old value', () => {
    // `Object.keys` reports it; JSON.stringify and yaml.stringify both drop it. The reconcile
    // path must agree with the create path, or "the key set matches the payload" is only
    // approximately true.
    expect(serializeYaml({ a: undefined })).toBe('{}\n')
    expect(serializeYaml({ a: undefined }, 'a: 1\n')).toBe('{}\n')
    expect(serializeYaml({ a: 1, b: undefined }, 'a: 0\nb: 2\n')).toBe('a: 1\n')
  })

  it('does not let a deleted list item leave its comment on newly-inserted content', () => {
    // A save that both removes an item and adds one has no identity information linking them.
    // Pairing them moved "do not delete" onto a brand-new block -- silently, and over exactly
    // the kind of comment this whole change exists to protect.
    const raw = `items:
  # about A
  - name: a
  # about B -- do not delete
  - name: b
`
    const out = serializeYaml({ items: [{ name: 'c' }, { name: 'a' }] }, raw)
    expect(out).toContain('- name: c')
    expect(out).toContain('- name: a')
    // The comment goes with the item it described, which is gone. It must NOT reappear anywhere.
    expect(out).not.toContain('do not delete')
  })

  it('does not migrate a comment onto a list item replaced wholesale at the same index', () => {
    // The replacement lands exactly where the old item was, so position alone cannot tell this
    // apart from an edit. Records carry evidence: a wholesale replacement shares no field value
    // with what it replaced.
    const raw = `items:
  - name: a
    role: x
  # FLAG: do not delete this block
  - name: b
    role: y
`
    const out = serializeYaml(
      {
        items: [
          { name: 'a', role: 'x' },
          { title: 'zzz', kind: 'q' },
        ],
      },
      raw,
    )
    expect(out).toContain('title: zzz')
    expect(out).not.toContain('FLAG: do not delete this block')
  })

  it('keeps a comment when an item at the same index is edited rather than replaced', () => {
    const raw = `items:
  - name: a
    role: x
  # FLAG: do not delete this block
  - name: b
    role: y
`
    const out = serializeYaml(
      {
        items: [
          { name: 'a', role: 'x' },
          { name: 'b2', role: 'y' },
        ],
      },
      raw,
    )
    // `role: y` survived the edit, so this is recognisably the same item.
    expect(out).toContain('# FLAG: do not delete this block')
    expect(out).toContain('name: b2')
    expect(out.indexOf('FLAG')).toBeLessThan(out.indexOf('name: b2'))
  })

  it('keeps a scalar list item comment across an in-place edit', () => {
    // Scalars carry no identity evidence, so they keep the plain same-index rule.
    const raw = 'items:\n  - one\n  # about the second\n  - two\n'
    const out = serializeYaml({ items: ['one', 'deux'] }, raw)
    expect(out).toContain('# about the second')
    expect(out).toContain('- deux')
  })

  it('drops the comment on a single-field record whose only field changed (accepted residual)', () => {
    // `{name: 'b'}` -> `{name: 'b2'}` shares no surviving field value, so it is indistinguishable
    // from a wholesale replacement. The rule errs toward dropping the comment rather than risking
    // moving it onto content it does not describe. Pinned so the trade-off is a decision, not a
    // surprise.
    const raw = `items:
  # about A
  - name: a
  # about B
  - name: b
`
    const out = serializeYaml({ items: [{ name: 'a' }, { name: 'b2' }] }, raw)
    expect(out).toContain('- name: b2')
    expect(out).not.toContain('# about B')
    // The list-head comment is unaffected.
    expect(out).toContain('# about A')
  })

  it('does not migrate a comment when a block is deleted and its successor edited in one save', () => {
    // The regression this whole rule exists to prevent, via the case it assumed could not happen.
    // Every Canopy block carries `template: <name>` -- a CATEGORY label, not an identity, so two
    // `hero` blocks share it. Deleting the first hero shifts the second onto index 0; if
    // `template` counts as identity evidence, the deleted block's comment migrates onto the
    // survivor and "keep this verbatim" ends up over content nobody wrote it about.
    // Three items, so the load-bearing comment sits on an ITEM rather than at the head of the
    // list -- a comment before the first item belongs to the seq node itself and never travels
    // (pinned separately below), which is not the case at issue here.
    const raw = `blocks:
  - template: hero
    value:
      headline: One
  # LEGAL: keep this disclaimer verbatim
  - template: hero
    value:
      headline: Disclaimer
  - template: hero
    value:
      headline: Three
`
    // One save that both deletes the Disclaimer block and edits its successor. "Three" shifts
    // from index 2 onto index 1, the slot the deleted block held.
    const out = serializeYaml(
      {
        blocks: [
          { template: 'hero', value: { headline: 'One' } },
          { template: 'hero', value: { headline: 'Three v2' } },
        ],
      },
      raw,
    )
    expect(out).toContain('headline: Three v2')
    expect(out).not.toContain('headline: Disclaimer')
    expect(out).not.toContain('LEGAL: keep this disclaimer verbatim')
  })

  it('does not migrate a comment across the inline `_type` block shape either', () => {
    // `resolveBlockItem` accepts `{ _type, ...inline fields }` as well as `{ template, value }`,
    // so the discriminator is exactly as misleading there -- and worse, it sits at the top level
    // beside the real fields rather than one level up from them.
    const raw = `blocks:
  - _type: hero
    headline: One
  # LEGAL: keep this disclaimer verbatim
  - _type: hero
    headline: Disclaimer
  - _type: hero
    headline: Three
`
    const out = serializeYaml(
      {
        blocks: [
          { _type: 'hero', headline: 'One' },
          { _type: 'hero', headline: 'Three v2' },
        ],
      },
      raw,
    )
    expect(out).toContain('headline: Three v2')
    expect(out).not.toContain('headline: Disclaimer')
    expect(out).not.toContain('LEGAL: keep this disclaimer verbatim')
  })

  it('still keeps a block comment when the block is edited and one nested field survives', () => {
    // The other half of the trade: excluding the discriminator must not reduce to "blocks never
    // keep comments". A block's real fields live one level down under `value`, so the evidence
    // search has to reach them -- comparing `value` whole would find nothing whenever any field
    // in it changed, which is every edit.
    const raw = `blocks:
  - template: hero
    value:
      headline: One
      body: Shared copy
  # FLAG: do not delete this block
  - template: hero
    value:
      headline: Two
      body: Keep me
`
    const out = serializeYaml(
      {
        blocks: [
          { template: 'hero', value: { headline: 'One', body: 'Shared copy' } },
          { template: 'hero', value: { headline: 'Two v2', body: 'Keep me' } },
        ],
      },
      raw,
    )
    expect(out).toContain('# FLAG: do not delete this block')
    expect(out).toContain('headline: Two v2')
    expect(out.indexOf('FLAG')).toBeLessThan(out.indexOf('headline: Two v2'))
  })

  it('drops a block comment when every field of the block changed (widened residual)', () => {
    // The cost of excluding the discriminator, pinned so it stays a decision. Before, `template`
    // alone kept this comment attached; now a block with nothing surviving is indistinguishable
    // from a replacement, so the comment is dropped. Per this module's stated priority that is
    // the correct direction -- a lost comment reads as a deletion in review, a moved one does
    // not read as anything at all.
    const raw = `blocks:
  - template: hero
    value:
      headline: One
  # FLAG: do not delete this block
  - template: hero
    value:
      headline: Two
      body: Old copy
`
    const out = serializeYaml(
      {
        blocks: [
          { template: 'hero', value: { headline: 'One' } },
          { template: 'hero', value: { headline: 'Two v2', body: 'New copy' } },
        ],
      },
      raw,
    )
    expect(out).toContain('headline: Two v2')
    expect(out).not.toContain('FLAG: do not delete this block')
  })

  it('does not harvest identity evidence element-wise from a list field', () => {
    // Lists are compared whole, never by index: a list has no item identity, so pairing its
    // elements positionally to prove the PARENT is the same item would be the same guess this
    // module refuses one level up. Here the two records share only a list element, which must
    // not be enough.
    const raw = `items:
  - name: a
  # FLAG: do not delete
  - name: b
    tags:
      - shared
      - only-b
`
    const out = serializeYaml(
      {
        items: [{ name: 'a' }, { name: 'c', tags: ['shared', 'only-c'] }],
      },
      raw,
    )
    expect(out).toContain('name: c')
    expect(out).not.toContain('FLAG: do not delete')
  })

  it('does not fail a save when the payload is cyclic or the file self-references', () => {
    // "A save must never fail because of it" is this module's rule for unkeyable input, and the
    // evidence walk is a second place that could break it. A cyclic payload is reachable from
    // server-side callers; a self-referential anchor is reachable from a hand-edited file.
    const cyclic: Record<string, unknown> = { name: 'b' }
    cyclic.self = cyclic
    expect(() =>
      serializeYaml({ items: [{ name: 'a' }, cyclic] }, 'items:\n  - name: a\n  - name: b\n'),
    ).not.toThrow()

    const anchored = `items:
  - name: a
  - &b
    name: b
    self: *b
`
    expect(() => serializeYaml({ items: [{ name: 'a' }, { name: 'b2' }] }, anchored)).not.toThrow()
  })

  it('keeps a non-leading item comment with its item when another is prepended', () => {
    const raw = `items:
  # about A
  - name: a
  # about B -- do not delete
  - name: b
`
    const out = serializeYaml({ items: [{ name: 'new' }, { name: 'a' }, { name: 'b' }] }, raw)
    expect(out.indexOf('- name: new')).toBeLessThan(out.indexOf('- name: a'))
    // B moved from index 1 to index 2; its comment moved with it, not with the index.
    expect(out.indexOf('do not delete')).toBeGreaterThan(out.indexOf('- name: a'))
    expect(out.indexOf('do not delete')).toBeLessThan(out.indexOf('- name: b'))
  })

  it('drops a mapping-head comment when the mapping is replaced by a plain value', () => {
    // `yaml` attaches a comment above a collection's first entry to the collection node, so it
    // describes that collection's innards. Replacing the collection wholesale destroys what the
    // comment was about; carrying it onto the replacement puts it over unrelated content.
    const raw = `intro:
  # FLAG: explains the heading below
  heading: Hi
other: keep
`
    const out = serializeYaml({ intro: 'now a string', other: 'keep' }, raw)
    expect(out).toContain('intro: now a string')
    expect(out).not.toContain('FLAG')
    expect(out).toContain('other: keep')
  })

  it('still carries a comment when a plain value simply changes type', () => {
    // The old node is a scalar, not a structure: the comment is about this key's value, which
    // still exists. This is the case the shape-change rule must NOT swallow.
    const out = serializeYaml({ ...ADOPTER_DATA, title: 42 }, ADOPTER_YAML)
    expect(out).toContain('title: 42 # shown in the hero')
  })

  it('treats a comment before the FIRST list item as a comment on the list', () => {
    // `yaml` attaches a comment that leads a collection to the collection node, not to its first
    // child (verified against parseDocument). So it stays at the head of the list whatever
    // happens to the items -- which is the right reading of `# curated by hand, order matters`,
    // and worth pinning because it is the one comment position that does NOT travel.
    const raw = 'items:\n  # about the list\n  - a\n  - b\n'
    const out = serializeYaml({ items: ['z', 'a', 'b'] }, raw)
    // Presence first: without this, an absent comment gives indexOf === -1 and the position
    // assertion below passes vacuously.
    expect(out).toContain('# about the list')
    expect(out.indexOf('# about the list')).toBeLessThan(out.indexOf('- z'))
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
    expect(serializeFrontmatter('\nBody text here.\n', MD_DATA, undefined, 'md')).toBe(
      matter.stringify('\nBody text here.\n', MD_DATA),
    )
  })

  it('round-trips unchanged frontmatter with every comment intact', () => {
    expect(serializeFrontmatter('\nBody text here.\n', MD_DATA, MD, 'md')).toBe(MD)
  })

  it('keeps frontmatter comments when a field and the body both change', () => {
    const out = serializeFrontmatter(
      '\nRewritten body.\n',
      { ...MD_DATA, title: 'Goodbye' },
      MD,
      'md',
    )
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
    expect(serializeFrontmatter('\nBody.\n', MD_DATA, malformed, 'md')).toBe(
      matter.stringify('\nBody.\n', MD_DATA),
    )
  })

  it('falls back to gray-matter for a file with no frontmatter at all', () => {
    expect(serializeFrontmatter('\nBody.\n', MD_DATA, 'Just a body, no delimiters.\n', 'md')).toBe(
      matter.stringify('\nBody.\n', MD_DATA),
    )
  })

  it('preserves comments on the SECOND save of the same file', () => {
    // Regression guard: gray-matter's no-options call path reads and writes a process-global
    // content-keyed cache, and the object it returns on a cache HIT has lost `.matter`. Splitting
    // through that path preserved comments on the first save of a file and silently dropped them
    // on every save after — including across different entries that happen to share bytes.
    const first = serializeFrontmatter('\nOne.\n', MD_DATA, MD, 'md')
    const second = serializeFrontmatter('\nTwo.\n', MD_DATA, MD, 'md')
    expect(first).toContain('# Order matters: the first tag is the primary category.')
    expect(second).toContain('# Order matters: the first tag is the primary category.')
    expect(second).toContain('# Post metadata. Keep `draft` first')
  })
})

/**
 * The read path parses frontmatter with gray-matter, whose js-yaml reads YAML 1.1: a bare date is
 * a `Date` (carried over JSON as a timestamp string) and `014` is octal. The editor sends every
 * field back as it read it.
 */
describe('serializeFrontmatter compares values as the read path parsed them', () => {
  const DATED = `---
title: Launch # shown in the card
date: 2024-01-15
updated: 2024-01-15T10:30:00Z
mode: 014
history:
  - 2023-12-01
  - drafted
meta:
  published: 2024-03-01
---

Body.
`
  const asRead = (raw: string) =>
    JSON.parse(JSON.stringify(matter(raw, {}).data)) as Record<string, unknown>

  it('writes the file byte for byte when no value changed', () => {
    expect(asRead(DATED).date).toBe('2024-01-15T00:00:00.000Z')
    expect(serializeFrontmatter('\nBody.\n', asRead(DATED), DATED, 'md')).toBe(DATED)
  })

  it('treats a server-side Date like the timestamp the API would carry', () => {
    const data = { ...matter(DATED, {}).data }
    expect(data.date).toBeInstanceOf(Date)
    expect(serializeFrontmatter('\nBody.\n', data, DATED, 'md')).toBe(DATED)
  })

  it('writes a date the editor changed, and only that line', () => {
    const data = { ...asRead(DATED), date: '2024-02-20T00:00:00.000Z' }
    const out = serializeFrontmatter('\nBody.\n', data, DATED, 'md')
    expect(out).toBe(DATED.replace('date: 2024-01-15\n', 'date: 2024-02-20T00:00:00.000Z\n'))
    expect(asRead(out)).toEqual(data)
  })

  it('writes changed dates inside a list and a nested map, leaving their neighbours', () => {
    const read = asRead(DATED)
    const data = {
      ...read,
      history: ['2023-11-30T00:00:00.000Z', 'drafted'],
      meta: { published: '2024-04-01T00:00:00.000Z' },
    }
    const out = serializeFrontmatter('\nBody.\n', data, DATED, 'md')
    expect(out).toContain('title: Launch # shown in the card\ndate: 2024-01-15\n')
    expect(out).toContain('mode: 014\n')
    expect(asRead(out)).toEqual(data)
  })

  it('writes a value changed to what the yaml library, not the read path, reads on disk', () => {
    // `yaml` reads `014` as 14 and js-yaml as 12; the editor's 14 is a change.
    const data = { ...asRead(DATED), mode: 14 }
    expect(asRead(serializeFrontmatter('\nBody.\n', data, DATED, 'md'))).toEqual(data)
  })

  it('writes a date-like string as a string', () => {
    const data = { ...asRead(DATED), version: '2024-05-01' }
    expect(asRead(serializeFrontmatter('\nBody.\n', data, DATED, 'md'))).toEqual(data)
  })
})

/**
 * Hand-written the way an author's editor leaves a file: folded and plain scalars wrapped at
 * uneven widths (some past 80 columns, some well short), comments at several levels, and a
 * CanopyCMS-style block list of `{ template, value }` items.
 */
const HAND_FOLDED = `# Synthetic landing page used by the source-preservation tests.
# Folded by hand at uneven widths, the way an author's editor leaves it.

title: Field notes from the observatory
description: >-
  A long folded description that the author wrapped by hand at a width
  well past eighty columns, because their editor was configured that way and nobody minded it.
summary: >-
  Short lines
  here.
tagline: This plain scalar is long enough that the yaml library would fold it at eighty columns if it were re-emitted
quoted: "A double-quoted scalar that is also long enough to be folded by the library when it is re-emitted"
# Literal block, kept as-is.
notice: |
  Line one of a literal block.
  Line two, which is longer than the others and keeps going past the usual eighty-column limit.

hero:
  # Hero copy is reviewed by the comms team.
  heading: Look up
  body: >-
    Nested folded text wrapped narrowly
    at about forty
    columns.
sections:
  # Blocks render in this order.
  - template: callout
    value:
      tone: info # one of info | warn
      text: >-
        The first callout explains something at length, folded by hand at a width somewhat
        wider than the default.

  # Keep this block: the footer links to it.
  - template: gallery
    value:
      caption: A narrow caption
        that the author wrapped early.
      images:
        - src: /a.png
          alt: First
        - src: /b.png
          alt: Second
  - template: callout
    value:
      tone: warn
      text: Plain text on one line.
# Trailing file comment.
`

const FIRST_CALLOUT = `  - template: callout
    value:
      tone: info # one of info | warn
      text: >-
        The first callout explains something at length, folded by hand at a width somewhat
        wider than the default.
`
const GALLERY = `
  # Keep this block: the footer links to it.
  - template: gallery
    value:
      caption: A narrow caption
        that the author wrapped early.
      images:
        - src: /a.png
          alt: First
        - src: /b.png
          alt: Second
`

/** Replace the one occurrence of `from`; a fixture typo fails loudly instead of matching nothing. */
function replaceOnce(source: string, from: string, to: string): string {
  const at = source.indexOf(from)
  expect(at, `fixture text not found: ${JSON.stringify(from)}`).toBeGreaterThanOrEqual(0)
  expect(source.indexOf(from, at + 1), `fixture text not unique: ${JSON.stringify(from)}`).toBe(-1)
  return source.slice(0, at) + to + source.slice(at + from.length)
}

interface HandFoldedData {
  description: string
  summary: string
  notice: string
  title: string | number
  hero: { heading?: string; body: string }
  sections: Array<{ template?: string; value: Record<string, unknown> }>
  [key: string]: unknown
}

function handFoldedData(): HandFoldedData {
  return yamlParse(HAND_FOLDED) as HandFoldedData
}

describe('serializeYaml keeps the source text of everything it did not change', () => {
  it('returns the file byte-for-byte on a save that changes nothing', () => {
    expect(serializeYaml(handFoldedData(), HAND_FOLDED)).toBe(HAND_FOLDED)
  })

  it('changes only the edited value, which keeps its `>-` style', () => {
    const data = handFoldedData()
    data.description = 'An edited description.'
    const expected = replaceOnce(
      HAND_FOLDED,
      `  A long folded description that the author wrapped by hand at a width
  well past eighty columns, because their editor was configured that way and nobody minded it.
`,
      '  An edited description.\n',
    )
    expect(serializeYaml(data, HAND_FOLDED)).toBe(expected)
  })

  it('keeps a `|` literal a literal when it is edited', () => {
    const data = handFoldedData()
    data.notice = 'First line.\nSecond line.\n'
    const out = serializeYaml(data, HAND_FOLDED)
    expect(out).toContain('notice: |\n  First line.\n  Second line.\n\nhero:')
    expect(yamlParse(out)).toEqual(data)
  })

  it('edits a value deep inside a nested block list without touching its neighbours', () => {
    const data = handFoldedData()
    ;(data.sections[1].value.images as Array<{ alt: string }>)[0].alt = 'Primary'
    expect(serializeYaml(data, HAND_FOLDED)).toBe(
      replaceOnce(HAND_FOLDED, 'alt: First', 'alt: Primary'),
    )
  })

  it('removes a dropped key and only its lines', () => {
    const data = handFoldedData()
    delete data.hero.heading
    expect(serializeYaml(data, HAND_FOLDED)).toBe(
      replaceOnce(HAND_FOLDED, '  heading: Look up\n', ''),
    )
  })

  it('removes a dropped multi-line value with all of its lines', () => {
    const { summary: _summary, ...data } = handFoldedData()
    expect(serializeYaml(data, HAND_FOLDED)).toBe(
      replaceOnce(HAND_FOLDED, 'summary: >-\n  Short lines\n  here.\n', ''),
    )
  })

  it('appends an added key and leaves every existing line alone', () => {
    const data = { ...handFoldedData(), added: 'new value' }
    expect(serializeYaml(data, HAND_FOLDED)).toBe(
      replaceOnce(
        HAND_FOLDED,
        '# Trailing file comment.\n',
        'added: new value\n# Trailing file comment.\n',
      ),
    )
  })

  it('removes a list item together with the comment written above it', () => {
    const data = handFoldedData()
    data.sections.splice(1, 1)
    expect(serializeYaml(data, HAND_FOLDED)).toBe(replaceOnce(HAND_FOLDED, GALLERY, ''))
  })

  it('removes the first list item and keeps the comment that heads the list', () => {
    const data = handFoldedData()
    data.sections.splice(0, 1)
    expect(serializeYaml(data, HAND_FOLDED)).toBe(replaceOnce(HAND_FOLDED, FIRST_CALLOUT, ''))
  })

  it('reorders list items by moving their source text, comments and folding included', () => {
    const data = handFoldedData()
    data.sections = [data.sections[1], data.sections[0], data.sections[2]]
    // The gallery's chunk carries its blank line and comment along with it.
    const expected = replaceOnce(
      replaceOnce(HAND_FOLDED, FIRST_CALLOUT, ''),
      GALLERY,
      `${GALLERY}${FIRST_CALLOUT}`,
    )
    expect(serializeYaml(data, HAND_FOLDED)).toBe(expected)
  })

  it('inserts a new list item between untouched ones', () => {
    const data = handFoldedData()
    data.sections.splice(1, 0, { template: 'hero', value: { heading: 'New' } })
    expect(serializeYaml(data, HAND_FOLDED)).toBe(
      replaceOnce(
        HAND_FOLDED,
        FIRST_CALLOUT,
        `${FIRST_CALLOUT}  - template: hero\n    value:\n      heading: New\n`,
      ),
    )
  })

  it('drops the key that shares the `- ` line and keeps the rest of that item as written', () => {
    const data = handFoldedData()
    delete data.sections[0].template
    expect(serializeYaml(data, HAND_FOLDED)).toBe(
      replaceOnce(
        HAND_FOLDED,
        '  - template: callout\n    value:\n      tone: info',
        '  - value:\n      tone: info',
      ),
    )
  })

  it('keeps CRLF line endings, and touches only the edited line', () => {
    const crlf = HAND_FOLDED.replace(/\n/g, '\r\n')
    const data = handFoldedData()
    data.title = 'Edited title'
    expect(serializeYaml(handFoldedData(), crlf)).toBe(crlf)
    expect(serializeYaml(data, crlf)).toBe(
      replaceOnce(crlf, 'title: Field notes from the observatory', 'title: Edited title'),
    )
  })

  it('writes a new CRLF list item with CRLF line endings', () => {
    const crlf = HAND_FOLDED.replace(/\n/g, '\r\n')
    const data = handFoldedData()
    data.sections.push({ template: 'hero', value: { heading: 'New' } })
    const out = serializeYaml(data, crlf)
    expect(out).toBe(
      replaceOnce(
        crlf,
        '      text: Plain text on one line.\r\n',
        '      text: Plain text on one line.\r\n  - template: hero\r\n    value:\r\n      heading: New\r\n',
      ),
    )
  })

  it('writes a re-rendered value under a multi-line CRLF comment without stray carriage returns', () => {
    const crlf = 'a: 1\r\n  # t1\r\n  # t2\r\nb: 2\r\n'
    const out = serializeYaml({ a: 2, b: 2 }, crlf)
    expect(out).toBe(replaceOnce(crlf, 'a: 1', 'a: 2'))
    expect(serializeYaml({ a: 2, b: 2 }, out)).toBe(out)
  })

  it("writes a whole-file fallback with the CRLF file's own line endings", () => {
    const crlf = 'x: &a 1\r\ny: *a\r\n# c1\r\n# c2\r\nz: >-\r\n  hand\r\n  folded\r\n'
    const data = { x: 1, y: 1, z: 'edited' }
    const out = serializeYaml(data, crlf)
    expect(yamlParse(out)).toEqual(data)
    expect(out).toContain('\r\n')
    expect(out).not.toMatch(/\r(?!\n)|(?<!\r)\n/)
  })

  it("drops the comment above the root map's first key with that key, as the reconciler does", () => {
    const raw = '# about a\na: 1\n# about b\nb: 2\nzz: >-\n  hand\n  folded\n'
    expect(serializeYaml({ b: 2, zz: 'hand folded' }, raw)).toBe(
      replaceOnce(raw, '# about a\na: 1\n', ''),
    )
  })

  it('finishes a save that drops a commented first key from a file starting with a blank line', () => {
    expect(serializeYaml({ b: 2 }, '\n# about a\na: 1\nb: 2\n')).toBe('b: 2\n')
  })

  it('keeps a comment split by a lone carriage return as two comment lines', () => {
    const out = serializeYaml({ a: 1, b: 3 }, '# c\rmore\na: 1\nb: 2\n')
    expect(yamlParse(out)).toEqual({ a: 1, b: 3 })
    expect(out).toContain('# c\n#more\n')
  })

  it('falls back to a whole re-serialisation, with correct data, for a file using anchors', () => {
    const anchored = `base: &shared
  x: 1
copy: *shared
long: >-
  folded by hand at
  an odd width
other: keep
`
    const out = serializeYaml(
      { base: { x: 1 }, copy: { x: 1 }, long: 'folded by hand at an odd width', other: 'edited' },
      anchored,
    )
    expect(yamlParse(out)).toEqual({
      base: { x: 1 },
      copy: { x: 1 },
      long: 'folded by hand at an odd width',
      other: 'edited',
    })
    // The untouched `long` value was re-folded: the fallback, not the source splice, wrote it.
    expect(out).toContain('long: >-\n  folded by hand at an odd width\n')
  })

  it('falls back, with correct data, for a layout it does not splice (an explicit `?` key)', () => {
    const explicit = '? a\n: 1\nb: >-\n  hand\n  folded\n'
    const out = serializeYaml({ a: 1, b: 'edited' }, explicit)
    expect(yamlParse(out)).toEqual({ a: 1, b: 'edited' })
  })
})

describe('serializeYaml never trades data for style', () => {
  it('writes a plain value that becomes multi-line as YAML that parses back to it', () => {
    for (const summary of ['Requirements:\nBring a laptop', '?\nwhy', '-\nlist-like', 'a: b\nc']) {
      const out = serializeYaml({ title: 'T', summary }, 'title: T\nsummary: A short summary\n')
      expect(yamlParse(out)).toEqual({ title: 'T', summary })
    }
  })

  it('drops a block style the new value cannot keep, rather than changing the value', () => {
    const raw = 'desc: >-\n  Some text\nnote: |\n  literal\nb: 1\n'
    const values = [
      '   ',
      ' \t',
      '',
      ' Leading space and a long sentence that runs well past eighty columns of width here.',
    ]
    for (const value of values) {
      const data = { desc: value, note: value, b: 1 }
      expect(yamlParse(serializeYaml(data, raw))).toEqual(data)
    }
  })
})

describe('serializeYaml keeps comments with the items yaml gives them to', () => {
  it('indents an outdented comment under its owner once the item below it is removed', () => {
    // yaml reads `# Keep this CTA` as hero's: its run reaches into hero's map. Left at the item
    // column it would head faq, so it is drawn under hero, where `toString()` puts it; every
    // other line stays as written.
    const raw = `sections:
  - template: hero
    title: Hero
    # TODO: add image
  # Keep this CTA, legal requires it
  - template: cta
    label: Go

  # The FAQ block. Do not delete.
  - template: faq
    q: Why
`
    const data = yamlParse(raw) as { sections: unknown[] }
    data.sections.splice(1, 1)
    expect(serializeYaml(data, raw)).toBe(
      replaceOnce(
        raw,
        '  # Keep this CTA, legal requires it\n  - template: cta\n    label: Go\n',
        '    # Keep this CTA, legal requires it\n',
      ),
    )
  })

  it('does not let an outdented comment head a block inserted after its owner', () => {
    const raw = `sections:
  - template: hero
    value:
      title: Hero
      # note about hero
  # Keep this CTA, legal
  - template: cta
    value:
      label: Go
`
    const data = yamlParse(raw) as { sections: unknown[] }
    data.sections.splice(1, 0, { template: 'x', value: { a: 1 } })
    expect(serializeYaml(data, raw)).toBe(
      replaceOnce(
        raw,
        '  # Keep this CTA, legal\n',
        '      # Keep this CTA, legal\n  - template: x\n    value:\n      a: 1\n',
      ),
    )
  })

  it('does not let an outdented comment head the key after a deleted one', () => {
    const raw = 'hero:\n  title: x\n  # deep tail\n# about cta\ncta:\n  label: y\nfoot: z\n'
    expect(serializeYaml({ hero: { title: 'x' }, foot: 'z' }, raw)).toBe(
      'hero:\n  title: x\n  # deep tail\n  # about cta\nfoot: z\n',
    )
  })

  it('leaves a zero-indented list as written when a key is appended after it', () => {
    // `# about c` is c's leading comment: no line of the run reaches into the item above.
    const raw = 'mark: >-\n  folded by\n  hand\nitems:\n- a: 1\n  b: 2\n# about c\n- c: 3\n'
    const data = { ...(yamlParse(raw) as Record<string, unknown>), extra: 1 }
    expect(serializeYaml(data, raw)).toBe(`${raw}extra: 1\n`)
  })

  it('leaves a comment run alone when more of the item follows it', () => {
    // Only the run that ENDS the item can head its neighbour; `# about other` is other's.
    const raw =
      'hero:\n  sub:\n    deep: 1\n    # pinned mid\n  # about other\n  other: 2\nfoot: z\n'
    expect(serializeYaml({ hero: { sub: { deep: 1 }, other: 2 } }, raw)).toBe(
      replaceOnce(raw, 'foot: z\n', ''),
    )
  })

  it('stays local when the value holding a pinned comment run is dropped with its neighbour', () => {
    const raw =
      'mark: >-\n  folded by\n  hand\nhero:\n  title: x\n  sub:\n    deep: 1\n    # deep tail\n# about cta\ncta:\n  label: y\nfoot: z\n'
    expect(serializeYaml({ mark: 'folded by hand', hero: { title: 'x' }, foot: 'z' }, raw)).toBe(
      'mark: >-\n  folded by\n  hand\nhero:\n  title: x\nfoot: z\n',
    )
  })

  it("indents a pinned comment run to its deepest line, not to the item's last deeper line", () => {
    const raw = `mark: >-
  folded by
  hand
sections:
  - template: hero
    value:
      title: Hero
  # Keep this CTA
    # note at 4
  - template: cta
    label: Go
  - template: faq
    q: Why
`
    const data = yamlParse(raw) as { sections: unknown[] }
    data.sections.splice(1, 1)
    expect(serializeYaml(data, raw)).toBe(
      replaceOnce(
        raw,
        '  # Keep this CTA\n    # note at 4\n  - template: cta\n    label: Go\n',
        '    # Keep this CTA\n    # note at 4\n',
      ),
    )
  })

  it("indents a pinned comment that sits between the dash and the item's keys", () => {
    const raw = `sections:
  - template: hero
    value:
      title: Hero
      # note about hero
   # Keep this CTA
  - template: cta
    label: Go
`
    const data = yamlParse(raw) as { sections: unknown[] }
    data.sections.splice(1, 0, { template: 'x' })
    expect(serializeYaml(data, raw)).toBe(
      replaceOnce(raw, '   # Keep this CTA\n', '      # Keep this CTA\n  - template: x\n'),
    )
  })

  it("keeps a list local when a block's nested value ends in a comment", () => {
    const raw = `sections:
  - template: hero
    value:
      title: Hero
      # note about hero
  - template: cta
    value:
      body: >-
        hand folded text
        that is short
  - template: faq
    value:
      q: Why
`
    const data = yamlParse(raw) as { sections: Array<{ value: Record<string, unknown> }> }
    data.sections[2].value.q = 'How'
    expect(serializeYaml(data, raw)).toBe(replaceOnce(raw, 'q: Why', 'q: How'))
  })
})

describe('serializeFrontmatter keeps the source text of everything it did not change', () => {
  const POST = `---\n${HAND_FOLDED}---\n\nBody text.\n`

  it('returns the file byte-for-byte on a save that changes nothing', () => {
    expect(serializeFrontmatter('\nBody text.\n', handFoldedData(), POST, 'md')).toBe(POST)
  })

  it('finishes a save that drops the first key when a comment sits above it', () => {
    const post = '---\n# about title\ntitle: A\nb: 1\n---\nbody\n'
    expect(serializeFrontmatter('body\n', { b: 1 }, post, 'md')).toBe('---\nb: 1\n---\nbody\n')
  })

  it('keeps frontmatter readable when its keys are indented', () => {
    const indented = '---\n  title: A\n  b: 1\n---\nbody\n'
    for (const data of [
      { title: 'A', b: 1 },
      { title: 'B', b: 1 },
    ]) {
      const out = serializeFrontmatter('body\n', data, indented, 'md')
      expect(matter(out, {}).data).toEqual(data)
    }
  })

  it('changes only the edited value, which keeps its `>-` style', () => {
    const data = handFoldedData()
    data.hero.body = 'Edited body.'
    expect(serializeFrontmatter('\nBody text.\n', data, POST, 'md')).toBe(
      replaceOnce(
        POST,
        '    Nested folded text wrapped narrowly\n    at about forty\n    columns.\n',
        '    Edited body.\n',
      ),
    )
  })
})
