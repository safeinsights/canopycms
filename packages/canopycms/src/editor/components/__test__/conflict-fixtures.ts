/**
 * A synthetic md entry whose merge left one conflict of every kind the "Conflicts" group shows,
 * for its stories and tests: a changed field, a nested one, a field the latest version removed, one
 * you removed, a list item the latest version removed, a whole value (an image), a body with two
 * regions, and the entry's place. Plus an entry-level conflict of each kind.
 */

import type { EntryChangeSide } from '../../../api/branch-entry-changes'
import type {
  EntryConflictData,
  EntryConflictField,
  MergeConflictListItem,
} from '../../../api/merge-conflicts'
import type { FieldConfig } from '../../../config'
import { mergeText } from '../../../merge/text-merge'
import { formValueOfSide } from '../../undo-change'

export const ANCESTOR_SHA = 'a'.repeat(40)
export const BASE_SHA = 'b'.repeat(40)
export const BRANCH_SHA = 'c'.repeat(40)
export const MERGE_SHA = 'd'.repeat(40)

export const conflictFields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'tagline', type: 'string', label: 'Tagline' },
  { name: 'summary', type: 'string', label: 'Summary' },
  { name: 'readTime', type: 'number', label: 'Read time' },
  {
    name: 'hero',
    type: 'object',
    label: 'Hero',
    fields: [{ name: 'heading', type: 'string', label: 'Heading' }],
  },
  {
    name: 'steps',
    type: 'object',
    list: true,
    label: 'Steps',
    itemLabel: 'text',
    fields: [{ name: 'text', type: 'string', label: 'Step' }],
  },
  { name: 'cover', type: 'image', label: 'Cover image' },
  { name: 'body', type: 'markdown', label: 'Body', isBody: true },
]

const lines = (...text: string[]) => `${text.join('\n')}\n`

const ancestorBody = lines(
  '# Welcome',
  '',
  'Install the package first.',
  '',
  'Then add the route.',
  '',
  'Middle paragraph stays as it is.',
  '',
  'Ask for help in the forum.',
)
const baseBody = lines(
  '# Welcome, editors',
  '',
  'Install the package with pnpm first.',
  '',
  'Then add the route.',
  '',
  'Middle paragraph stays as it is.',
  '',
  'Ask for help in the chat.',
)
const branchBody = lines(
  '# Welcome',
  '',
  'Install the package and its peers first.',
  '',
  'Then add the route.',
  '',
  'Middle paragraph stays as it is.',
  '',
  'Ask for help on the issue tracker.',
)

const side = (data: Record<string, unknown>, body: string): EntryChangeSide => ({
  format: 'md',
  entryType: 'page',
  data,
  body,
  bodyFieldName: 'body',
})

export const ancestor = side(
  {
    title: 'Getting started',
    tagline: 'Start here',
    summary: 'How to begin.',
    readTime: 4,
    hero: { heading: 'Welcome' },
    steps: [
      { _key: 'k1', text: 'Install' },
      { _key: 'k2', text: 'Configure' },
    ],
    cover: { src: '/assets/a1/cover.jpg', alt: 'A forest path' },
  },
  ancestorBody,
)

export const latest = side(
  {
    title: 'Getting started',
    tagline: 'Start here today',
    summary: 'How to begin editing.',
    hero: { heading: 'Welcome, editors' },
    steps: [{ _key: 'k1', text: 'Install' }],
    cover: { src: '/assets/b2/cover-site.jpg', alt: 'A forest path' },
  },
  baseBody,
)

export const yours = side(
  {
    title: 'Getting started',
    summary: 'A guide to your first edit.',
    readTime: 6,
    hero: { heading: 'Welcome aboard' },
    steps: [
      { _key: 'k1', text: 'Install' },
      { _key: 'k2', text: 'Configure the site' },
    ],
    cover: { src: '/assets/c3/cover-mine.jpg', alt: 'A forest path' },
  },
  branchBody,
)

/** The body as the merge left it: the latest version's clean changes, your lines in each region. */
export const mergedBody = mergeText(ancestorBody, baseBody, branchBody)?.text ?? branchBody

/** Your entry as the merge left it, which the form loads: your value at every conflict. */
export const savedValue: Record<string, unknown> = {
  ...formValueOfSide(yours),
  body: mergedBody,
}

const sides = { ancestor: ANCESTOR_SHA, base: BASE_SHA, branch: BRANCH_SHA }

const field = (
  key: string,
  dataPath: EntryConflictField['dataPath'],
  kind: EntryConflictField['kind'],
  extra: Partial<EntryConflictField> = {},
): EntryConflictField => ({
  key,
  drawerKey: key,
  dataPath,
  sidePaths: { ancestor: dataPath, base: dataPath, branch: dataPath },
  kind,
  mergeSha: MERGE_SHA,
  sides,
  ...extra,
})

export const conflictRecordFields = {
  summary: field('summary', [{ field: 'summary' }], 'changed'),
  heading: field('hero.heading', [{ field: 'hero' }, { field: 'heading' }], 'changed'),
  readTime: field('readTime', [{ field: 'readTime' }], 'removed-on-base'),
  tagline: field('tagline', [{ field: 'tagline' }], 'removed-by-you'),
  step: field('steps.k2', [{ field: 'steps' }, { item: 'k2' }], 'removed-on-base', {
    item: true,
  }),
  cover: field('cover', [{ field: 'cover' }], 'changed'),
  body: field('body', [{ field: 'body' }], 'changed', { text: true }),
  location: field('@location', [], 'changed'),
} satisfies Record<string, EntryConflictField>

/** The entry's record as `GET /:branch/conflicts/...entryPath` answers it, with `only` its fields. */
export function fieldsConflictData(
  only: ReadonlyArray<keyof typeof conflictRecordFields> = Object.keys(
    conflictRecordFields,
  ) as Array<keyof typeof conflictRecordFields>,
): EntryConflictData {
  return {
    contentId: 'pg0000000001',
    kind: 'fields',
    path: 'content/pages/page.getting-started.pg0000000001.md',
    logicalPath: 'content/pages/getting-started',
    mergeSha: MERGE_SHA,
    sides,
    fields: only.map((name) => conflictRecordFields[name]),
    versions: { [ANCESTOR_SHA]: ancestor, [BASE_SHA]: latest, [BRANCH_SHA]: yours },
  }
}

/** An entry-level conflict of `kind`. */
export function entryConflictData(
  kind: Exclude<EntryConflictData['kind'], 'fields'>,
): EntryConflictData {
  return {
    ...fieldsConflictData([]),
    kind,
    sides:
      kind === 'deleted-on-base'
        ? { ancestor: ANCESTOR_SHA, branch: BRANCH_SHA }
        : kind === 'deleted-on-branch'
          ? { ancestor: ANCESTOR_SHA, base: BASE_SHA }
          : sides,
    fields: [],
  }
}

/** The branch's list as `GET /:branch/conflicts` names this entry. */
export const conflictListItem = (fieldCount: number): MergeConflictListItem => ({
  contentId: 'pg0000000001',
  kind: 'fields',
  path: 'content/pages/page.getting-started.pg0000000001.md',
  logicalPath: 'content/pages/getting-started',
  fieldCount,
  mergeSha: MERGE_SHA,
})
