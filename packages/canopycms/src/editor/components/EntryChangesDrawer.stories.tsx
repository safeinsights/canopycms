import type { Meta, StoryObj } from '@storybook/react'

import type { BranchEntryChangeData, EntryChangeSide } from '../../api/branch-entry-changes'
import type { FieldConfig } from '../../config'
import { withItemKeys } from '../../item-keys'
import { EntryChangesDrawer, type EntryChangesDrawerProps } from './EntryChangesDrawer'

const noop = () => {}

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'featured', type: 'boolean' },
  { name: 'publishedAt', type: 'datetime', label: 'Published' },
  { name: 'author', type: 'reference', label: 'Author' },
  { name: 'cover', type: 'image', label: 'Cover image' },
  {
    name: 'sections',
    type: 'block',
    label: 'Page sections',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [{ name: 'heading', type: 'string', label: 'Heading' }],
      },
      {
        name: 'faq',
        label: 'FAQ',
        fields: [
          {
            name: 'questions',
            type: 'object',
            list: true,
            label: 'Questions',
            itemLabel: 'question',
            fields: [
              { name: 'question', type: 'string', label: 'Question' },
              { name: 'answer', type: 'string', label: 'Answer' },
            ],
          },
        ],
      },
    ],
  },
  { name: 'content', type: 'markdown', label: 'Body', isBody: true },
]

const body = [
  '# Getting started',
  '',
  'CanopyCMS keeps every edit on a branch.',
  'Nothing reaches the live site until it is reviewed.',
  '',
  '## Saving',
  '',
  'Save writes the entry to the branch.',
  'Submit for review opens a pull request.',
  '',
].join('\n')

const baseData = {
  title: 'Getting started',
  featured: false,
  publishedAt: '2026-09-01T09:00:00.000Z',
  author: 'ada000000001',
  cover: { src: '/assets/a1/cover-old.jpg', alt: 'A forest path' },
  sections: [
    { template: 'hero', value: { heading: 'Welcome to the docs' } },
    {
      template: 'faq',
      value: {
        questions: [
          { question: 'Who can edit?', answer: 'Anyone with access to the branch.' },
          { question: 'Where do edits go?', answer: 'To a branch.' },
        ],
      },
    },
  ],
}

const side = (data: Record<string, unknown>, text: string = body): EntryChangeSide => ({
  format: 'md',
  entryType: 'doc',
  data: withItemKeys(fields, data, 'content'),
  body: text,
})

const before = side(baseData)
const afterData = structuredClone(before.data) as typeof baseData
afterData.title = 'Getting started with CanopyCMS'
afterData.featured = true
afterData.author = 'grace0000002'
afterData.cover = { src: '/assets/b2/cover-new.jpg', alt: 'A forest path at dawn' }
afterData.sections[0].value.heading = 'Welcome to the CanopyCMS docs'
const faq = afterData.sections[1].value as { questions: Array<Record<string, string>> }
faq.questions = [faq.questions[1], faq.questions[0]]
faq.questions[0].answer = 'To a branch of their own.'
const after = side(
  afterData,
  body
    .replace('Nothing reaches the live site', 'Nothing reaches your live site')
    .replace(
      'Submit for review opens a pull request.',
      'Submit for review opens a pull request.\nA reviewer approves it.',
    ),
)

const answer = (data: Partial<BranchEntryChangeData>): EntryChangesDrawerProps['state'] => ({
  data: { before, after, mergeBaseSha: 'a'.repeat(40), ...data },
  error: undefined,
  isValidating: false,
  reload: async () => {},
})

const titles: Record<string, string> = { ada000000001: 'Ada Lovelace' }

const meta: Meta<typeof EntryChangesDrawer> = {
  title: 'Editor/EntryChangesDrawer',
  component: EntryChangesDrawer,
  parameters: { layout: 'fullscreen' },
  args: {
    opened: true,
    onClose: noop,
    base: 'main',
    subject: {
      logicalPath: 'content/docs/getting-started',
      status: 'modified',
      title: 'Getting started',
      fields,
    },
    state: answer({}),
    referenceTitle: (id: string) => titles[id],
  },
}

export default meta
type Story = StoryObj<typeof EntryChangesDrawer>

/** Nested blocks, a reordered list, a reference to an entry the list lacks, and a body. */
export const NestedBlocksAndBody: Story = {}

export const NestedBlocksAndBodyDark: Story = { globals: { colorScheme: 'dark' } }

export const NewEntry: Story = {
  args: {
    subject: { ...meta.args!.subject!, status: 'added' },
    state: answer({ before: null }),
  },
}

export const DeletedEntry: Story = {
  args: {
    subject: { ...meta.args!.subject!, status: 'deleted' },
    state: answer({ after: null }),
  },
}

export const MovedEntry: Story = {
  args: {
    subject: {
      ...meta.args!.subject!,
      status: 'moved',
      from: 'content/guides/getting-started',
      movedFromLabel: 'Guides › getting-started',
    },
    state: answer({ after: { ...before, data: { ...before.data, title: 'Getting started!' } } }),
  },
}

export const FormattingOnly: Story = {
  args: { state: answer({ after: before }) },
}

export const UnsavedEdits: Story = {
  args: { subject: { ...meta.args!.subject!, unsavedEdits: true } },
}

export const Loading: Story = {
  args: { state: { ...answer({}), data: undefined } },
}

/** A 409, in yellow and the server's words, over what was shown before. */
export const Syncing: Story = {
  args: {
    state: {
      ...answer({}),
      error: {
        kind: 'syncing',
        message: 'This branch is being synced with main. Try again in a moment.',
      },
    },
  },
}

export const Failed: Story = {
  args: {
    state: { ...answer({}), data: undefined, error: { kind: 'failed', message: 'HTTP 503' } },
  },
}

export const TooLarge: Story = {
  args: {
    onOpenEntry: noop,
    state: { ...answer({}), data: undefined, error: { kind: 'tooLarge', message: 'x' } },
  },
}

/** A 404: no side to compare, with the ways the entry can still be looked at. */
export const NotComparable: Story = {
  args: {
    onOpenEntry: noop,
    pullRequestUrl: 'https://example.com/pull/7',
    state: { ...answer({}), data: undefined, error: { kind: 'notFound', message: 'x' } },
  },
}

/** A 422: one side doesn't parse. */
export const Unreadable: Story = {
  args: {
    onOpenEntry: noop,
    state: { ...answer({}), data: undefined, error: { kind: 'unreadable', message: 'x' } },
  },
}

/** 2,000 lines inserted into a body: Before and After stay level, row by row. */
export const LongInsertion: Story = {
  args: {
    state: answer({
      after: side(
        afterData,
        body.replace(
          '## Saving\n',
          `## Saving\n${Array.from({ length: 2000 }, (_, i) => `Inserted line ${i + 1}`).join('\n')}\n`,
        ),
      ),
    }),
  },
}

/** A whitespace-only change and a mostly rewritten title. */
export const Whitespace: Story = {
  args: {
    state: answer({
      after: side({ ...afterData, title: 'Getting  started' }),
    }),
  },
}

/** A changed publish date: in full, the changed part marked, then relative. */
export const ChangedPublishedAt: Story = {
  args: {
    state: answer({
      before: side({ title: 'Getting started', publishedAt: '2026-09-01T09:00:00.000Z' }),
      after: side({ title: 'Getting started', publishedAt: '2026-09-14T16:30:00.000Z' }),
    }),
  },
}

/** A new entry whose body runs past 200 lines: the first 50, then "Show all N lines". */
export const LongNewBody: Story = {
  args: {
    subject: { ...meta.args!.subject!, status: 'added' },
    state: answer({
      before: null,
      after: side(
        { title: 'Getting started' },
        Array.from({ length: 260 }, (_, i) => `Line ${i + 1} of the guide.`).join('\n'),
      ),
    }),
  },
}

/** At phone width each card's Before and After stack. */
export const Narrow: Story = {
  parameters: {
    viewport: {
      viewports: { phone: { name: 'Phone', styles: { width: '390px', height: '844px' } } },
      defaultViewport: 'phone',
    },
  },
}
