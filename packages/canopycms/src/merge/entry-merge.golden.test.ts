/**
 * Golden tests: four synthetic entries shaped like the conflicts that made the field merge
 * necessary, each with its ancestor, base and branch file text, and the exact merge. Git's
 * line merge reports 7, 11, 1 and 7 conflict regions for them; the field merge reports 0, 2, 1
 * and 0 conflicts.
 */

import { describe, expect, it } from 'vitest'

import type { ContentFormat, FieldConfig } from '../config'
import { parseEntryParts } from '../content-listing'
import { itemKeysAsRead } from '../item-keys'
import { mergeEntry, type EntryMergeResult, type MergeSide } from './entry-merge'

type Item = Record<string, string>

/** The key a read gives `item` while it carries none: what an editor's first save writes. */
const readKey = (item: Item): string => itemKeysAsRead([item])[0]!

const yamlList = (name: string, items: Item[], withKeys: boolean): string =>
  `${name}:\n` +
  items
    .map((item) => {
      const lines = Object.entries(item).map(
        ([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`,
      )
      if (withKeys) lines.push(`    _key: ${readKey(item)}`)
      return lines.join('\n')
    })
    .join('\n') +
  '\n'

const side = (text: string, format: ContentFormat): MergeSide => {
  const { data, body } = parseEntryParts(text, format)
  return { data, ...(body !== undefined && { body }) }
}

const merge = (
  texts: { ancestor: string; base: string; branch: string },
  format: ContentFormat,
  fields?: FieldConfig[],
): Extract<EntryMergeResult, { kind: 'merged' }> => {
  const result = mergeEntry({
    format,
    ancestor: side(texts.ancestor, format),
    base: side(texts.base, format),
    branch: side(texts.branch, format),
    ...(fields && { fields }),
  })
  if (result.kind !== 'merged') throw new Error(`expected a merge, got ${result.kind}`)
  expect(JSON.stringify(result)).not.toMatch(/<{7}|>{7}|={7}|\|{7}/)
  return result
}

const conflictList = (result: { conflicts: Array<{ key: string; kind: string }> }) =>
  result.conflicts.map(({ key, kind }) => ({ key, kind }))

const stringFields = (...names: string[]): FieldConfig[] =>
  names.map((name) => ({ name, type: 'string' }))

// --- Fixtures 1 and 4: a guide whose list items the base reworded --------------------------------

const steps: Item[] = [
  ['Install the tool', 'download', '/install', 'Run the installer for your system.'],
  ['Create a project', 'folder', '/projects', 'Pick a folder and start a new project.'],
  ['Add a page', 'file', '/pages', 'Pages live in the content folder.'],
  ['Preview it', 'eye', '/preview', 'Open the preview to see your page.'],
  ['Invite a colleague', 'users', '/team', 'Share access with one more person.'],
  ['Publish', 'send', '/publish', 'Submit the branch for review.'],
  ['Celebrate', 'star', '/done', 'You shipped your first page.'],
].map(([title, icon, link, detail]) => ({ title, icon, link, level: 'basic', detail }))

const rewordings = [
  'Run the installer that matches your operating system.',
  'Choose a folder, then start a new project there.',
  'Every page lives in the content folder.',
  'Open the preview pane to check your page.',
  'Give one more person access to the project.',
  'Submit your branch so a reviewer can approve it.',
  'Your first page is live.',
]
const reworded: Item[] = steps.map((s, i) => ({ ...s, detail: rewordings[i] }))

const guideBody = 'Welcome to the guide.\n\nFollow the steps above in order.\n'
const guide = (items: Item[], keys: boolean, extra = '') =>
  `---\ntitle: Getting started\n${extra}${yamlList('steps', items, keys)}---\n${guideBody}`
const summary = 'summary: A short walk through your first page.\n'

const guideFields: FieldConfig[] = [
  { name: 'title', type: 'string' },
  { name: 'summary', type: 'string' },
  {
    name: 'steps',
    type: 'object',
    list: true,
    fields: stringFields('title', 'icon', 'link', 'level', 'detail'),
  },
  { name: 'body', type: 'markdown', isBody: true },
]

describe('fixture 1: keys an editor first save wrote beside items the base reworded', () => {
  const texts = {
    ancestor: guide(steps, false),
    base: guide(reworded, false),
    branch: guide(steps, true, summary),
  }

  it('merges with no conflicts: the rewordings, the summary, and the branch keys', () => {
    const result = merge(texts, 'md', guideFields)
    expect(result.conflicts).toEqual([])
    expect(result.data).toEqual({
      title: 'Getting started',
      summary: 'A short walk through your first page.',
      steps: reworded.map((s, i) => ({ ...s, _key: readKey(steps[i]) })),
    })
    expect(result.body).toBe(guideBody)
    expect(result.keyRemaps).toEqual([])
  })

  it('carries the keys rather than comparing them as content: the branch keys survive', () => {
    const result = merge(texts, 'md')
    const keys = (result.data.steps as Item[]).map((s) => s._key)
    expect(keys).toEqual(steps.map(readKey))
    expect(keys.every((k) => typeof k === 'string')).toBe(true)
  })
})

describe('fixture 4: a key backfill run on the base after it reworded the items', () => {
  const texts = {
    ancestor: guide(steps, false),
    base: guide(reworded, true),
    branch: guide(steps, true, summary),
  }

  it('merges with no conflicts on the base keys, remapping the branch threads 7 times', () => {
    const result = merge(texts, 'md', guideFields)
    expect(result.conflicts).toEqual([])
    expect(result.data.steps).toEqual(reworded.map((s) => ({ ...s, _key: readKey(s) })))
    expect(result.data.summary).toBe('A short walk through your first page.')
    expect(result.keyRemaps).toEqual(
      steps.map((s, i) => ({ within: [], from: readKey(s), to: readKey(reworded[i]) })),
    )
  })

  it('treats a key as identity only when the ancestor knows it: 7 edits, not 7 swaps', () => {
    // The branch also edits one step's title. Read as 7 removed and 7 added items, the base would
    // have removed the step the branch edited: an item conflict, and a duplicate step.
    const edited = steps.map((s, i) => (i === 2 ? { ...s, title: 'Add your first page' } : s))
    const result = merge({ ...texts, branch: guide(edited, true, summary) }, 'md')
    expect(result.conflicts).toEqual([])
    expect(result.data.steps).toEqual(
      reworded.map((s, i) => ({
        ...s,
        ...(i === 2 && { title: 'Add your first page' }),
        _key: readKey(s),
      })),
    )
    expect(result.keyRemaps).toHaveLength(7)
  })
})

// --- Fixture 2: four entries, two real clashes ---------------------------------------------------

const teamA: Item[] = [
  { name: 'Ada', photo: '/img/ada.jpg', city: 'Remote', team: 'Platform', role: 'Engineer' },
  { name: 'Grace', photo: '/img/grace.jpg', city: 'Remote', team: 'Product', role: 'Designer' },
  { name: 'Linus', photo: '/img/linus.jpg', city: 'Remote', team: 'Content', role: 'Writer' },
]
const teamBase = teamA.map((m) => ({ ...m, role: `${m.role} lead` }))
const aboutBody = (p1: string, p3: string) =>
  `${p1}\n\nWe started in a small room with three desks.\n\n${p3}\n\nWrite to us any time.\n`
const about = (
  title: string,
  description: string,
  team: Item[],
  keys: boolean,
  p1: string,
  p3: string,
) =>
  `---\ntitle: ${title}\ndescription: ${description}\n${yamlList('team', team, keys)}---\n${aboutBody(p1, p3)}`

const plans: Item[] = [
  { name: 'Starter', seats: '1', support: 'Community', price: '0' },
  { name: 'Team', seats: '10', support: 'Email', price: '12' },
  { name: 'Company', seats: '50', support: 'Phone', price: '40' },
]
const basePlans = plans.map((p, i) =>
  i === 1 ? { ...p, price: '15' } : i === 2 ? { ...p, price: '45' } : p,
)
const pricing = (heading: string, cta: string, list: Item[], keys: boolean) =>
  JSON.stringify(
    {
      hero: { heading, sub: 'Pick a plan.' },
      cta,
      plans: list.map((p) => (keys ? { ...p, _key: readKey(p) } : p)),
    },
    null,
    2,
  ) + '\n'
const pricingFields: FieldConfig[] = [
  { name: 'hero', type: 'object', fields: stringFields('heading', 'sub') },
  { name: 'cta', type: 'string' },
  {
    name: 'plans',
    type: 'object',
    list: true,
    fields: stringFields('name', 'seats', 'support', 'price'),
  },
]

const post = (postSummary: string, tags: string[], date: string, p2: string) =>
  `---\ntitle: Release notes\nsummary: ${postSummary}\n${date}tags:\n${tags
    .map((t) => `  - ${t}`)
    .join('\n')}\n---\nThis release brings three changes.\n\n${p2}\n\nThanks for reading.\n`
const postFields: FieldConfig[] = [
  ...stringFields('title', 'summary'),
  { name: 'date', type: 'date' },
  { name: 'tags', type: 'string', list: true },
  { name: 'body', type: 'markdown', isBody: true },
]

const links: Item[] = [
  { href: '/', icon: 'home', target: 'same', group: 'main', label: 'Home' },
  { href: '/docs', icon: 'book', target: 'same', group: 'main', label: 'Docs' },
  { href: '/blog', icon: 'pen', target: 'same', group: 'more', label: 'Blog' },
  { href: '/contact', icon: 'mail', target: 'same', group: 'more', label: 'Contact' },
]
const baseLinks = links.map((l, i) => (i !== 2 ? { ...l, label: `${l.label} page` } : l))
const statusLink: Item = {
  href: '/status',
  icon: 'pulse',
  target: 'same',
  group: 'more',
  label: 'Status',
}
const footer = (list: Item[], keys: boolean, added: Item[] = []) =>
  `copyright: 2026 Example Co\n${yamlList('links', [...list], keys).replace(/\n$/, '')}${
    added.length ? `\n${yamlList('x', added, true).split('\n').slice(1).join('\n')}` : '\n'
  }`

describe('fixture 2: four entries, most hunks disjoint, two real clashes', () => {
  it('about (md): disjoint fields, keys, two different body paragraphs, all merged', () => {
    const result = merge(
      {
        ancestor: about(
          'About us',
          'Who we are.',
          teamA,
          false,
          'We build tools for small teams.',
          'Today we are twelve people.',
        ),
        base: about(
          'About the team',
          'Who we are.',
          teamBase,
          false,
          'We build calm tools for small teams.',
          'Today we are twelve people.',
        ),
        branch: about(
          'About us',
          'Who we are and what we make.',
          teamA,
          true,
          'We build tools for small teams.',
          'Today we are fourteen people in two offices.',
        ),
      },
      'md',
    )
    expect(result.conflicts).toEqual([])
    expect(result.data).toEqual({
      title: 'About the team',
      description: 'Who we are and what we make.',
      team: teamBase.map((m, i) => ({ ...m, _key: readKey(teamA[i]) })),
    })
    expect(result.body).toBe(
      aboutBody(
        'We build calm tools for small teams.',
        'Today we are fourteen people in two offices.',
      ),
    )
  })

  it('pricing (json): one clash at hero.heading; the base prices and branch cta merge', () => {
    const result = merge(
      {
        ancestor: pricing('Simple pricing', 'Start free', plans, false),
        base: pricing('Pricing that scales', 'Start free', basePlans, false),
        branch: pricing('Plans for every team', 'Try it free', plans, true),
      },
      'json',
      pricingFields,
    )
    expect(result.conflicts).toEqual([
      {
        key: 'hero.heading',
        dataPath: [{ field: 'hero' }, { field: 'heading' }],
        kind: 'changed',
        ancestor: 'Simple pricing',
        base: 'Pricing that scales',
        branch: 'Plans for every team',
      },
    ])
    expect(result.data).toEqual({
      hero: { heading: 'Plans for every team', sub: 'Pick a plan.' },
      cta: 'Try it free',
      plans: basePlans.map((p, i) => ({ ...p, _key: readKey(plans[i]) })),
    })
  })

  it('release notes (md): one clash at summary; the base tag, branch date and body merge', () => {
    const result = merge(
      {
        ancestor: post('What changed this month.', ['release'], '', 'First, saving is faster.'),
        base: post(
          'Everything new in this release.',
          ['release', 'product'],
          '',
          'First, saving is faster.',
        ),
        branch: post(
          'A month of fixes and one big feature.',
          ['release'],
          'date: 2026-11-01\n',
          'First, saving is faster and safer.',
        ),
      },
      'md',
      postFields,
    )
    expect(conflictList(result)).toEqual([{ key: 'summary', kind: 'changed' }])
    expect(result.data).toEqual({
      title: 'Release notes',
      summary: 'A month of fixes and one big feature.',
      date: new Date('2026-11-01T00:00:00.000Z'),
      tags: ['release', 'product'],
    })
    expect(result.body).toBe(
      'This release brings three changes.\n\nFirst, saving is faster and safer.\n\nThanks for reading.\n',
    )
  })

  it('footer (yaml): base label edits, branch keys and an added link, all merged', () => {
    const result = merge(
      {
        ancestor: footer(links, false),
        base: footer(baseLinks, false),
        branch: footer(links, true, [statusLink]),
      },
      'yaml',
    )
    expect(result.conflicts).toEqual([])
    expect(result.data).toEqual({
      copyright: '2026 Example Co',
      links: [
        ...baseLinks.map((l, i) => ({ ...l, _key: readKey(links[i]) })),
        { ...statusLink, _key: readKey(statusLink) },
      ],
    })
  })
})

// --- Fixture 3: a schema migration on the base ---------------------------------------------------

const article = (frontmatter: string, p2: string) =>
  `---\n${frontmatter}---\nNotes from the field.\n\n${p2}\n\nMore next month.\n`

describe('fixture 3: the base migrated the schema; the branch edited the old shape', () => {
  const texts = {
    ancestor: article(
      'title: Field notes\nauthor: Sam Rivera\nreviewer: Kai Moreno\nreadTime: 4\ntags:\n  - notes\n',
      'We visited three sites this week.',
    ),
    base: article(
      'title: Field notes\ntags:\n  - notes\nreviewers:\n  - name: Sam Rivera\n    role: author\n  - name: Kai Moreno\n    role: reviewer\n',
      'We visited three sites this week.',
    ),
    branch: article(
      'title: Field notes from the coast\nauthor: Sam Rivera\nreviewer: Kai Moreno\nreadTime: 6\ntags:\n  - notes\n',
      'We visited three coastal sites this week.',
    ),
  }

  it('keeps the migration, applies the branch edits, and conflicts on readTime alone', () => {
    const result = merge(texts, 'md')
    expect(result.conflicts).toEqual([
      {
        key: '?readTime',
        dataPath: [{ field: 'readTime' }],
        kind: 'removed-on-base',
        ancestor: 4,
        branch: 6,
      },
    ])
    expect(result.data).toEqual({
      title: 'Field notes from the coast',
      readTime: 6,
      tags: ['notes'],
      reviewers: [
        { name: 'Sam Rivera', role: 'author' },
        { name: 'Kai Moreno', role: 'reviewer' },
      ],
    })
    expect(result.body).toBe(
      'Notes from the field.\n\nWe visited three coastal sites this week.\n\nMore next month.\n',
    )
  })

  it('passes items neither side keyed through untouched: no key minted in the new list', () => {
    const result = merge(texts, 'md')
    const reviewers = result.data.reviewers as Item[]
    expect(reviewers).toHaveLength(2)
    expect(reviewers.map((r) => Object.keys(r))).toEqual([
      ['name', 'role'],
      ['name', 'role'],
    ])
  })
})
