import type { Meta, StoryObj } from '@storybook/react'
import { useMemo, useState } from 'react'

import type { CommentThread } from '../comment-store'
import type { FieldConfig } from '../config'
import { FormRenderer } from './FormRenderer'
import { ReadOnlyDraftNotice } from './components/ReadOnlyDraftNotice'
import { NEW_ITEM_COMMENT_MESSAGE } from './comments/item-anchor-copy'

type HeroBlock = {
  template: 'hero'
  value: { headline?: string; body?: string }
}
type CtaBlock = { template: 'cta'; value: { title?: string; ctaText?: string } }
type PostBlock = HeroBlock | CtaBlock

interface PostValue {
  title: string
  author: string
  tags: string[]
  published: boolean
  body: string
  seo: { title?: string; description?: string }
  features: Array<{ title?: string; description?: string }>
  blocks: PostBlock[]
  [key: string]: unknown
}

const meta: Meta<typeof FormRenderer> = {
  title: 'Editor/FormRenderer',
  component: FormRenderer,
}

export default meta
type Story = StoryObj<typeof FormRenderer>

const authors = [
  { id: 'authors/alice', name: 'Alice' },
  { id: 'authors/bob', name: 'Bob' },
]

const postSchema: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    options: authors.map((a) => ({ label: a.name, value: a.id })),
    required: true,
  },
  {
    name: 'tags',
    type: 'select',
    label: 'Tags',
    list: true,
    options: ['typed', 'fast', 'lambda-friendly'],
  },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'mdx', label: 'Body' },
  {
    name: 'seo',
    type: 'object',
    label: 'SEO',
    fields: [
      { name: 'title', type: 'string', label: 'Meta title' },
      { name: 'description', type: 'string', label: 'Meta description' },
    ],
  },
  {
    name: 'features',
    type: 'object',
    label: 'Key features',
    list: true,
    itemTitleField: 'title',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
    ],
  },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'body', type: 'markdown' },
        ],
      },
      {
        name: 'cta',
        label: 'CTA',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'ctaText', type: 'string' },
        ],
      },
    ],
  },
]

const Preview: React.FC<{ value: PostValue }> = ({ value }) => {
  const authorMap = useMemo(() => Object.fromEntries(authors.map((a) => [a.id, a.name])), [])
  return (
    <div className="flex flex-col gap-3 rounded border border-gray-200 p-4">
      <div>
        <div className="text-sm font-semibold text-gray-800">{value.title}</div>
        <div className="text-xs text-gray-600">
          Author: {authorMap[value.author] ?? 'Unknown'} · {value.published ? 'Published' : 'Draft'}
        </div>
      </div>
      <div className="text-sm text-gray-700 whitespace-pre-wrap">{value.body}</div>
      <div className="flex flex-wrap gap-2">
        {(value.tags ?? []).map((tag) => (
          <span key={tag} className="rounded bg-blue-50 px-2 py-1 text-[11px] text-blue-700">
            {tag}
          </span>
        ))}
      </div>
      {value.seo && (
        <div className="rounded bg-gray-50 p-2 text-xs text-gray-700">
          <div className="font-semibold">SEO</div>
          <div>Title: {value.seo.title}</div>
          <div>Description: {value.seo.description}</div>
        </div>
      )}
      {Array.isArray(value.features) && value.features.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold text-gray-700">Features</div>
          {value.features.map((feat, idx) => (
            <div
              key={`${feat.title}-${idx}`}
              className="rounded border border-gray-200 p-2 text-xs"
            >
              <div className="font-semibold">{feat.title}</div>
              <div className="text-gray-700">{feat.description}</div>
            </div>
          ))}
        </div>
      )}
      {Array.isArray(value.blocks) && value.blocks.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold text-gray-700">Blocks</div>
          {value.blocks.map((block, idx) => {
            if (block.template === 'hero') {
              return (
                <div key={`hero-${idx}`} className="rounded bg-indigo-50 p-3">
                  <div className="text-sm font-semibold">{block.value.headline}</div>
                  <div className="text-gray-700">{block.value.body}</div>
                </div>
              )
            }
            if (block.template === 'cta') {
              return (
                <div key={`cta-${idx}`} className="rounded bg-emerald-50 p-3">
                  <div className="text-sm font-semibold">{block.value.title}</div>
                  <button className="mt-1 rounded bg-emerald-600 px-3 py-1 text-xs text-white">
                    {block.value.ctaText}
                  </button>
                </div>
              )
            }
            return (
              <div key={`unknown-${idx}`} className="text-xs text-gray-500">
                Unknown block
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const initialPost: PostValue = {
  title: 'Hello World',
  author: 'authors/alice',
  tags: ['typed', 'fast'],
  published: false,
  body: 'Some **MDX** content that mirrors another example.',
  seo: {
    title: 'Hello World | CanopyCMS',
    description: 'Welcome to the demo story.',
  },
  features: [
    { title: 'Fast', description: 'Built for speed' },
    { title: 'Typed', description: 'Type-safe content' },
  ],
  blocks: [
    {
      template: 'hero',
      value: { headline: 'Hero block', body: 'Hero copy' },
    },
    {
      template: 'cta',
      value: { title: 'Try CanopyCMS', ctaText: 'Click me' },
    },
  ],
}

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<PostValue>(initialPost)

    return (
      <div className="grid grid-cols-2 gap-4">
        <FormRenderer
          fields={postSchema}
          value={value}
          onChange={(next) => setValue(next as unknown as PostValue)}
        />
        <Preview value={value} />
      </div>
    )
  },
}

/**
 * In a scroller like the editor's form pane: the header stays at the top while the form scrolls,
 * "Outline" jumps to a field or row, and the chevrons expand or collapse every list.
 */
const HeaderScroller: React.FC<{ readOnly?: boolean }> = ({ readOnly = false }) => {
  const [value, setValue] = useState<PostValue>(initialPost)
  return (
    <div
      style={
        {
          '--canopy-form-pane-padding': '20px',
          padding: 'var(--canopy-form-pane-padding)',
          height: 600,
          maxWidth: 560,
          overflow: 'auto',
          backgroundColor: 'var(--canopy-surface-muted)',
        } as React.CSSProperties
      }
    >
      <FormRenderer
        fields={postSchema}
        value={value}
        onChange={(next) => setValue(next as unknown as PostValue)}
        readOnly={readOnly}
        // The editor names the entry by its saved title, which a draft does not change.
        header={{ title: initialPost.title, typeLabel: 'Post' }}
      />
    </div>
  )
}

export const WithHeader: Story = { render: () => <HeaderScroller /> }

/** Read-only: the outline and Expand or Collapse all lists still work. */
export const WithHeaderReadOnly: Story = { render: () => <HeaderScroller readOnly /> }

/** A locked branch: every field shows its value read-only, with no add, remove or reorder. */
export const ReadOnly: Story = {
  render: () => (
    <FormRenderer fields={postSchema} value={initialPost} onChange={() => {}} readOnly />
  ),
}

/** As the editor shows a read-only entry that has a draft kept from earlier. */
export const ReadOnlyWithKeptDraft: Story = {
  render: () => (
    <FormRenderer
      fields={postSchema}
      value={initialPost}
      onChange={() => {}}
      readOnly
      notice={<ReadOnlyDraftNotice permanentlyReadOnly={false} onDiscard={() => {}} />}
    />
  ),
}

const storyThread = (
  id: string,
  type: CommentThread['type'],
  canopyPath: string | undefined,
  text: string,
  resolved = false,
): CommentThread => ({
  id,
  type,
  entryPath: 'posts/hello',
  canopyPath,
  authorId: 'alice',
  createdAt: new Date(Date.now() - 3600000).toISOString(),
  resolved,
  comments: [
    {
      id: `${id}-1`,
      threadId: id,
      userId: 'alice',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      text,
    },
  ],
})

const sampleThreads: CommentThread[] = [
  storyThread('t1', 'field', 'title', 'Can we make this punchier?'),
  storyThread('t2', 'field', 'title', 'Check capitalisation.'),
  storyThread('t3', 'field', 'blocks[0].headline', 'Shorter, please.'),
  storyThread('t4', 'entry', undefined, 'Ready for review once the hero is final.'),
  storyThread('t5', 'field', 'seo.description', 'Under 160 characters now.', true),
]

/** Scrolls inside a fixed-height pane, as the editor's form does, so popovers place as they would there. */
const CommentingForm: React.FC<{
  readOnly?: boolean
  fieldErrors?: Record<string, string>
  initialThreads?: CommentThread[]
  commentBlockedReason?: (canopyPath: string) => string | undefined
  removedItemFieldLabel?: (thread: CommentThread) => string | undefined
}> = ({
  readOnly,
  fieldErrors,
  initialThreads = sampleThreads,
  commentBlockedReason,
  removedItemFieldLabel,
}) => {
  const [value, setValue] = useState<PostValue>(initialPost)
  const [threads, setThreads] = useState<CommentThread[]>(initialThreads)
  return (
    <div style={{ height: '90vh', overflowY: 'auto', paddingBottom: 20 }}>
      <FormRenderer
        fields={postSchema}
        value={value}
        onChange={(next) => setValue(next as unknown as PostValue)}
        readOnly={readOnly}
        fieldErrors={fieldErrors}
        commentBlockedReason={commentBlockedReason}
        removedItemFieldLabel={removedItemFieldLabel}
        comments={threads}
        currentEntryPath="posts/hello"
        currentUserId="alice"
        canResolve
        onAddComment={async (text, type, entryPath, canopyPath, threadId) => {
          setThreads((prev) =>
            threadId
              ? prev.map((t) =>
                  t.id === threadId
                    ? {
                        ...t,
                        comments: [
                          ...t.comments,
                          {
                            id: `${threadId}-${t.comments.length + 1}`,
                            threadId,
                            userId: 'alice',
                            timestamp: new Date().toISOString(),
                            text,
                          },
                        ],
                      }
                    : t,
                )
              : [...prev, storyThread(`t${prev.length + 1}`, type, canopyPath ?? undefined, text)],
          )
        }}
        onResolveThread={async (threadId) => {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === threadId ? { ...t, resolved: true, resolvedBy: 'alice' } : t,
            ),
          )
        }}
      />
    </div>
  )
}

/**
 * "Field comments" (⌘⌥M or Ctrl+Alt+M) lists the fields with threads, resolved ones included,
 * and every field; beside it, "Comment on this entry". A field with open threads shows a count
 * badge, and any other field an icon after its label while hovered or focused.
 */
export const WithComments: Story = {
  render: () => <CommentingForm />,
}

/** No threads yet: the "Field comments" menu says so, and still lists every field. */
export const WithNoCommentsYet: Story = {
  render: () => <CommentingForm initialThreads={[]} />,
}

/** Comments stay open on a read-only branch, where reviewers comment on a submitted entry. */
export const ReadOnlyWithComments: Story = {
  render: () => <CommentingForm readOnly />,
}

/** The validation summary names fields by their labels; each breadcrumb focuses its field. */
export const WithValidationErrors: Story = {
  render: () => (
    <CommentingForm
      fieldErrors={{
        title: 'This field is required',
        'features[1].description': 'Expected text',
        'blocks[0].headline': 'This field is required',
      }}
    />
  ),
}

const clickOnceRendered = async (selector: string) => {
  for (let i = 0; i < 20; i++) {
    const element = document.querySelector<HTMLElement>(selector)
    if (element) {
      element.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * A thread whose item was removed lives on "Comment on this entry", marked "On a removed item",
 * with its field's breadcrumb. While the removal is only in the draft, the editor names the item
 * from the saved value.
 */
export const RemovedItemThread: Story = {
  render: () => (
    <CommentingForm
      initialThreads={[
        {
          ...storyThread('t-gone', 'field', 'features[2].description', 'Is this still true?'),
          itemKeys: ['k-gone'],
          onRemovedItem: true,
        },
        storyThread('t4', 'entry', undefined, 'Ready for review once the hero is final.'),
      ]}
      removedItemFieldLabel={() => 'Key features › Offline › Description'}
    />
  ),
  play: () => clickOnceRendered('[data-testid="entry-comment-button"]'),
}

/** A field inside an item added since the last save takes no new thread until the entry is saved. */
export const CommentBlockedOnUnsavedItem: Story = {
  render: () => (
    <CommentingForm
      initialThreads={[]}
      commentBlockedReason={(path) =>
        path.startsWith('features[1]') ? NEW_ITEM_COMMENT_MESSAGE : undefined
      }
    />
  ),
  play: () => clickOnceRendered('[data-testid="field-comment-features[1].title"]'),
}
