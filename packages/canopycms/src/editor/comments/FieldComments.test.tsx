import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@mdxeditor/editor'

import type { CommentThread } from '../../comment-store'
import type { FieldConfig } from '../../config'
import { primitiveFieldTypes } from '../../config'
import type { MockApiClient } from '../../api/__test__/mock-client'
import { createApiClientWrapper, setupMockApiClient } from '../hooks/__test__/test-utils'
import { FormRenderer, type FormRendererProps } from '../FormRenderer'
import { TextField } from '../fields/TextField'
import { FieldCommentContext } from './field-comment-context'
import { CanopyCMSProvider } from '../theme'

// ImageField and ReferenceField reach the API client through context; one mocked factory keeps
// createApiClientWrapper's provider and the hooks' own createApiClient() on the same instance.
vi.mock('../../api', async () => {
  const actual = await vi.importActual('../../api')
  return { ...actual, createApiClient: vi.fn() }
})

const showNotification = vi.hoisted(() => vi.fn())
vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications')
  return { ...actual, notifications: { ...actual.notifications, show: showNotification } }
})

const ENTRY = 'content/pages/home'

const thread = (
  id: string,
  canopyPath: string | undefined,
  opts: { resolved?: boolean; text?: string; type?: CommentThread['type'] } = {},
): CommentThread => ({
  id,
  type: opts.type ?? 'field',
  entryPath: ENTRY,
  canopyPath,
  authorId: 'alice',
  createdAt: '2026-10-01T10:00:00Z',
  resolved: opts.resolved ?? false,
  comments: [
    {
      id: `${id}-c1`,
      threadId: id,
      userId: 'alice',
      timestamp: '2026-10-01T10:00:00Z',
      text: opts.text ?? `Comment in ${id}`,
    },
  ],
})

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'meta',
    type: 'object',
    label: 'Meta',
    fields: [{ name: 'summary', type: 'string', label: 'Summary' }],
  },
  {
    name: 'links',
    type: 'object',
    label: 'Links',
    list: true,
    fields: [{ name: 'href', type: 'string', label: 'Href' }],
  },
]

const renderForm = (props: Partial<FormRendererProps> = {}) => {
  const onAddComment = vi.fn(async () => {})
  const onResolveThread = vi.fn(async () => {})
  render(
    <CanopyCMSProvider>
      <FormRenderer
        fields={fields}
        value={{ title: 'Hello', meta: { summary: 'S' }, links: [{ href: '/a' }] }}
        onChange={() => {}}
        currentEntryPath={ENTRY}
        currentUserId="alice"
        canResolve
        onAddComment={onAddComment}
        onResolveThread={onResolveThread}
        {...props}
      />
    </CanopyCMSProvider>,
  )
  return { onAddComment, onResolveThread }
}

const control = (path: string) => screen.getByTestId(`field-comment-${path}`)
const isRevealed = (el: HTMLElement) => el.style.opacity !== '0'

describe('field comment control', () => {
  it('sits in the field label row, named "Comment on <label>"', () => {
    renderForm()
    const icon = control('title')
    expect(icon.getAttribute('aria-label')).toBe('Comment on Title')
    // The label row holds both the label and the control, and the label still names the input.
    const row = icon.closest('.mantine-Group-root')
    expect(row && within(row as HTMLElement).getByText('Title')).toBeTruthy()
    expect(screen.getByLabelText('Title')).toBe(screen.getByDisplayValue('Hello'))
  })

  it('shows on hover of its field and hides when the pointer leaves', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(isRevealed(control('title'))).toBe(false)
    await user.hover(screen.getByLabelText('Title'))
    expect(isRevealed(control('title'))).toBe(true)
    await user.unhover(screen.getByLabelText('Title'))
    expect(isRevealed(control('title'))).toBe(false)
  })

  it('shows while focus is in its field, and when the control itself takes keyboard focus', async () => {
    const user = userEvent.setup()
    renderForm()
    act(() => screen.getByLabelText('Title').focus())
    expect(isRevealed(control('title'))).toBe(true)
    act(() => screen.getByLabelText('Title').blur())
    expect(isRevealed(control('title'))).toBe(false)
    // Idle, the control is out of the tab order: Shift+Tab from the input passes it.
    expect(control('title').getAttribute('tabindex')).toBe('-1')
    act(() => screen.getByLabelText('Title').focus())
    await user.tab({ shift: true })
    expect(document.activeElement).not.toBe(control('title'))
    act(() => screen.getByLabelText('Title').blur())
    act(() => control('title').focus())
    expect(isRevealed(control('title'))).toBe(true)
  })

  it("shows only the innermost field's control when a nested field is hovered", async () => {
    const user = userEvent.setup()
    renderForm()
    await user.hover(screen.getByLabelText('Summary'))
    expect(isRevealed(control('meta.summary'))).toBe(true)
    expect(isRevealed(control('meta'))).toBe(false)
    await user.hover(screen.getByText('Meta'))
    expect(isRevealed(control('meta'))).toBe(true)
    expect(isRevealed(control('meta.summary'))).toBe(false)
  })

  it('renders one control per field, and none on list item titles', () => {
    renderForm()
    expect(screen.getAllByTestId(/^field-comment-/).map((el) => el.dataset.testid)).toEqual([
      'field-comment-title',
      'field-comment-meta',
      'field-comment-meta.summary',
      'field-comment-links',
      'field-comment-links[0].href',
    ])
  })

  it("never puts a field's control in another field's label", () => {
    render(
      <CanopyCMSProvider>
        <FieldCommentContext.Provider
          value={{ canopyPath: 'meta', control: <button type="button">Parent control</button> }}
        >
          <TextField label="Summary" value="" onChange={() => {}} dataCanopyField="meta.summary" />
          <TextField label="Meta text" value="" onChange={() => {}} dataCanopyField="meta" />
        </FieldCommentContext.Provider>
      </CanopyCMSProvider>,
    )
    expect(screen.getAllByRole('button', { name: 'Parent control' })).toHaveLength(1)
    const row = screen
      .getByRole('button', { name: 'Parent control' })
      .closest('.mantine-Group-root')
    expect(row && within(row as HTMLElement).queryByText('Meta text')).toBeTruthy()
  })

  it('shows a persistent, tabbable badge counting open threads, and hides resolved-only ones until hovered', async () => {
    const user = userEvent.setup()
    renderForm({
      comments: [
        thread('t1', 'title'),
        thread('t2', 'title'),
        thread('t3', 'title', { resolved: true }),
        thread('t4', 'meta.summary', { resolved: true }),
      ],
    })
    const badge = control('title')
    expect(badge.textContent).toBe('2')
    expect(badge.getAttribute('aria-label')).toBe('Comment on Title (2 open threads)')
    expect(isRevealed(badge)).toBe(true)
    expect(badge.hasAttribute('tabindex')).toBe(false)
    expect(control('meta.summary').textContent).toBe('')
    expect(control('meta.summary').getAttribute('aria-label')).toBe('Comment on Meta › Summary')
    expect(isRevealed(control('meta.summary'))).toBe(false)
    expect(control('meta.summary').getAttribute('tabindex')).toBe('-1')
    await user.hover(screen.getByLabelText('Summary'))
    expect(isRevealed(control('meta.summary'))).toBe(true)
    expect(isRevealed(control('meta'))).toBe(false)
  })

  it("names each control by the field's breadcrumb, so list items' fields are told apart", () => {
    renderForm({ value: { links: [{ href: '/a' }, { href: '/b' }] } })
    expect(control('links[0].href').getAttribute('aria-label')).toBe('Comment on Links › /a › Href')
    expect(control('links[1].href').getAttribute('aria-label')).toBe('Comment on Links › /b › Href')
  })

  it('keeps the text and says why when a new comment fails', async () => {
    const user = userEvent.setup()
    showNotification.mockClear()
    renderForm({
      onAddComment: vi.fn(async () => {
        throw new Error("Couldn't add the comment. Try again.")
      }),
    })
    await user.click(control('title'))
    const box = await screen.findByTestId('new-thread-textarea')
    await user.type(box, 'Keep me')
    await user.click(screen.getByTestId('create-thread-button'))
    expect(await screen.findByText("Couldn't add the comment. Try again.")).toBeTruthy()
    expect((screen.getByTestId('new-thread-textarea') as HTMLTextAreaElement).value).toBe('Keep me')
    // Shown where it was written, so not again as a toast.
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('moves focus to "New thread" once a new thread is posted', async () => {
    const user = userEvent.setup()
    const Stateful = () => {
      const [comments, setComments] = React.useState<CommentThread[]>([])
      return (
        <CanopyCMSProvider>
          <FormRenderer
            fields={fields}
            value={{ title: 'Hello' }}
            onChange={() => {}}
            currentEntryPath={ENTRY}
            currentUserId="alice"
            comments={comments}
            onAddComment={async (text) => {
              setComments((prev) => [...prev, thread('new', 'title', { text })])
            }}
            onResolveThread={async () => {}}
          />
        </CanopyCMSProvider>
      )
    }
    render(<Stateful />)
    await user.click(control('title'))
    await user.type(await screen.findByTestId('new-thread-textarea'), 'First')
    await user.click(screen.getByTestId('create-thread-button'))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('new-thread-button')),
    )
  })

  it('opens a popover with the threads, open ones first, with reply and Resolve', async () => {
    const user = userEvent.setup()
    const { onAddComment, onResolveThread } = renderForm({
      comments: [thread('old', 'title', { resolved: true }), thread('open', 'title')],
    })
    await user.click(control('title'))
    const popover = await screen.findByTestId('field-comment-title-popover')
    // With threads to read, focus lands on the heading, not on a reply box.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Comments on Title'))
    const threads = within(popover).getAllByTestId('inline-comment-thread')
    expect(threads.map((t) => t.textContent)).toEqual([
      expect.stringContaining('Comment in open'),
      expect.stringContaining('Comment in old'),
    ])

    await user.click(within(threads[0]).getByTestId('reply-thread-button'))
    await user.type(within(threads[0]).getByRole('textbox'), 'Fixed it')
    await user.click(within(threads[0]).getByTestId('submit-reply-button'))
    expect(onAddComment).toHaveBeenCalledWith('Fixed it', 'field', ENTRY, 'title', 'open')

    await user.click(within(threads[0]).getByTestId('resolve-thread-button'))
    expect(onResolveThread).toHaveBeenCalledWith('open')
  })

  it('shows a Reply button per open thread rather than a reply box each', async () => {
    const user = userEvent.setup()
    renderForm({
      comments: [
        thread('a', 'title'),
        thread('b', 'title'),
        thread('c', 'title', { resolved: true }),
      ],
    })
    await user.click(control('title'))
    const popover = await screen.findByTestId('field-comment-title-popover')

    expect(within(popover).getAllByTestId('reply-thread-button')).toHaveLength(2)
    expect(
      within(popover).queryAllByRole('textbox', { name: 'Reply to this thread' }),
    ).toHaveLength(0)
  })

  it('starts a thread from the popover of a field without one', async () => {
    const user = userEvent.setup()
    const { onAddComment } = renderForm()
    await user.click(control('meta.summary'))
    const box = await screen.findByTestId('new-thread-textarea')
    await waitFor(() => expect(document.activeElement).toBe(box))
    await user.type(box, 'Too long')
    await user.click(screen.getByTestId('create-thread-button'))
    expect(onAddComment).toHaveBeenCalledWith('Too long', 'field', ENTRY, 'meta.summary', undefined)
  })

  it('opens on a highlighted thread', async () => {
    renderForm({ comments: [thread('t1', 'title')], highlightThreadId: 't1' })
    const popover = await screen.findByTestId('field-comment-title-popover')
    expect(within(popover).getByText('Comment in t1')).toBeTruthy()
  })
})

describe('entry comments', () => {
  it('offers "Comment on this entry" at the top of the form, counting open threads', async () => {
    const user = userEvent.setup()
    const { onAddComment } = renderForm({
      comments: [thread('e1', undefined, { type: 'entry' }), thread('f1', 'title')],
    })
    const button = screen.getByTestId('entry-comment-button')
    expect(button.textContent).toContain('Comment on this entry')
    expect(button.getAttribute('aria-label')).toBe('Comment on this entry (1 open thread)')
    // It comes before every field in the form.
    expect(
      button.compareDocumentPosition(control('title')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await user.click(button)
    const popover = await screen.findByTestId('entry-comment-button-popover')
    expect(within(popover).getAllByTestId('inline-comment-thread')).toHaveLength(1)
    await user.click(within(popover).getByTestId('new-thread-button'))
    await user.type(within(popover).getByTestId('new-thread-textarea'), 'Whole page')
    await user.click(within(popover).getByTestId('create-thread-button'))
    expect(onAddComment).toHaveBeenCalledWith('Whole page', 'entry', ENTRY, undefined, undefined)
  })
})

describe('field comment control, across field types and states', () => {
  let mockClient: MockApiClient
  beforeEach(async () => {
    mockClient = await setupMockApiClient()
  })

  const renderWith = (props: Partial<FormRendererProps> & Pick<FormRendererProps, 'fields'>) => {
    const Wrapper = createApiClientWrapper(mockClient)
    render(
      <CanopyCMSProvider>
        <Wrapper>
          <FormRenderer
            value={{}}
            onChange={() => {}}
            currentEntryPath={ENTRY}
            currentUserId="alice"
            onAddComment={vi.fn(async () => {})}
            onResolveThread={vi.fn(async () => {})}
            {...props}
          />
        </Wrapper>
      </CanopyCMSProvider>,
    )
  }

  it('gives every built-in field type exactly one control, in its own label row', () => {
    const typed: FieldConfig[] = [
      ...primitiveFieldTypes.map((type) => ({ name: `f_${type}`, type, label: `Field ${type}` })),
      { name: 'f_strings', type: 'string', list: true, label: 'Strings' },
      { name: 'f_numbers', type: 'number', list: true, label: 'Numbers' },
      { name: 'f_select', type: 'select', label: 'Pick', options: ['a', 'b'] },
      { name: 'f_multi', type: 'select', list: true, label: 'Picks', options: ['a', 'b'] },
      { name: 'f_ref', type: 'reference', label: 'Ref', options: [{ label: 'A', value: 'a' }] },
      { name: 'f_image', type: 'image', label: 'Picture' },
      { name: 'f_blocks', type: 'block', label: 'Sections', templates: [] },
    ] as FieldConfig[]
    renderWith({ fields: typed })
    for (const field of typed) {
      const controls = screen.getAllByTestId(`field-comment-${field.name}`)
      expect(controls, field.name).toHaveLength(1)
      // The label row holds the field's label text, so the control sits next to it.
      const row = controls[0].closest('.mantine-Group-root')!.parentElement!
      expect(within(row).getAllByText(field.label!).length, field.name).toBeGreaterThan(0)
    }
  })

  it("puts a custom renderer's control in its corner, usable on a read-only form", async () => {
    const user = userEvent.setup()
    renderWith({
      fields: [{ name: 'color', type: 'color', label: 'Colour' } as FieldConfig],
      customRenderers: { color: () => <input aria-label="Colour" /> },
      readOnly: true,
    })
    const corner = control('color')
    expect(corner.matches(':disabled')).toBe(false)
    expect(corner.closest('fieldset')).toBeNull()
    await user.click(corner)
    expect(await screen.findByTestId('new-thread-textarea')).toBeTruthy()
  })

  it('opens on a highlighted thread that arrives after the highlight', async () => {
    const Wrapper = createApiClientWrapper(mockClient)
    const props = {
      fields: [{ name: 'title', type: 'string', label: 'Title' }] as FieldConfig[],
      value: {},
      onChange: () => {},
      currentEntryPath: ENTRY,
      currentUserId: 'alice',
      onAddComment: vi.fn(async () => {}),
      onResolveThread: vi.fn(async () => {}),
      highlightThreadId: 'late',
    }
    const { rerender } = render(
      <CanopyCMSProvider>
        <Wrapper>
          <FormRenderer {...props} comments={[]} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    expect(screen.queryByTestId('field-comment-title-popover')).toBeNull()
    rerender(
      <CanopyCMSProvider>
        <Wrapper>
          <FormRenderer {...props} comments={[thread('late', 'title')]} />
        </Wrapper>
      </CanopyCMSProvider>,
    )
    expect(await screen.findByTestId('field-comment-title-popover')).toBeTruthy()
  })

  it('opens only the field whose thread is highlighted', async () => {
    renderWith({
      fields: [
        { name: 'title', type: 'string', label: 'Title' },
        { name: 'summary', type: 'string', label: 'Summary' },
      ],
      comments: [thread('t1', 'title'), thread('t2', 'summary')],
      highlightThreadId: 't2',
    })
    expect(await screen.findByTestId('field-comment-summary-popover')).toBeTruthy()
    expect(screen.queryByTestId('field-comment-title-popover')).toBeNull()
  })
})

describe('field comment popover, keyboard and drafts', () => {
  const Stateful: React.FC<{ initial?: CommentThread[] }> = ({ initial = [] }) => {
    const [comments, setComments] = React.useState<CommentThread[]>(initial)
    return (
      <CanopyCMSProvider>
        <FormRenderer
          fields={fields}
          value={{ title: 'Hello' }}
          onChange={() => {}}
          currentEntryPath={ENTRY}
          currentUserId="alice"
          canResolve
          comments={comments}
          onAddComment={async (text) => {
            setComments((prev) => [...prev, thread(`n${prev.length}`, 'title', { text })])
          }}
          onResolveThread={async (id) => {
            setComments((prev) => prev.map((t) => (t.id === id ? { ...t, resolved: true } : t)))
          }}
        />
      </CanopyCMSProvider>
    )
  }

  it('keeps the same control element when the first thread makes it a badge, so Escape returns to it', async () => {
    const user = userEvent.setup()
    render(<Stateful />)
    const before = control('title')
    await user.click(before)
    await user.type(await screen.findByTestId('new-thread-textarea'), 'First')
    await user.click(screen.getByTestId('create-thread-button'))
    await waitFor(() => expect(control('title').textContent).toBe('1'))
    expect(control('title')).toBe(before)
    await waitFor(() =>
      expect(
        screen.getByTestId('field-comment-title-popover').contains(document.activeElement),
      ).toBe(true),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(before))
  })

  it('keeps focus inside the popover after Resolve', async () => {
    const user = userEvent.setup()
    render(<Stateful initial={[thread('t1', 'title')]} />)
    await user.click(control('title'))
    const popover = await screen.findByTestId('field-comment-title-popover')
    await user.click(within(popover).getByTestId('resolve-thread-button'))
    await waitFor(() => expect(within(popover).getByText('Resolved')).toBeTruthy())
    await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true))
  })

  it('keeps an unsent new comment and reply when the popover closes', async () => {
    const user = userEvent.setup()
    render(<Stateful initial={[thread('t1', 'title')]} />)
    await user.click(control('title'))
    let popover = await screen.findByTestId('field-comment-title-popover')
    await user.click(within(popover).getByTestId('reply-thread-button'))
    await user.type(
      within(popover).getByRole('textbox', { name: 'Reply to this thread' }),
      'Half a reply',
    )
    await user.click(within(popover).getByTestId('new-thread-button'))
    await user.type(within(popover).getByTestId('new-thread-textarea'), 'Half a thread')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())

    await user.click(control('title'))
    popover = await screen.findByTestId('field-comment-title-popover')
    expect(
      (
        within(popover).getByRole('textbox', {
          name: 'Reply to this thread',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Half a reply')
    await user.click(within(popover).getByTestId('new-thread-button'))
    expect((within(popover).getByTestId('new-thread-textarea') as HTMLTextAreaElement).value).toBe(
      'Half a thread',
    )
  })
})

describe('field comment popover, across entries and slow posts', () => {
  const props = (entryPath: string, onAddComment: FormRendererProps['onAddComment']) => ({
    fields: [{ name: 'title', type: 'string', label: 'Title' }] as FieldConfig[],
    value: { title: 'Hello' },
    onChange: () => {},
    currentEntryPath: entryPath,
    currentUserId: 'alice',
    onAddComment,
    onResolveThread: vi.fn(async () => {}),
  })

  it('drops a draft when the entry changes, so it never posts on another entry', async () => {
    const user = userEvent.setup()
    const onAddComment = vi.fn(async () => {})
    const { rerender } = render(
      <CanopyCMSProvider>
        <FormRenderer {...props('content/a', onAddComment)} />
      </CanopyCMSProvider>,
    )
    await user.click(control('title'))
    await user.type(await screen.findByTestId('new-thread-textarea'), 'Draft for A')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())

    rerender(
      <CanopyCMSProvider>
        <FormRenderer {...props('content/b', onAddComment)} />
      </CanopyCMSProvider>,
    )
    await user.click(control('title'))
    expect(((await screen.findByTestId('new-thread-textarea')) as HTMLTextAreaElement).value).toBe(
      '',
    )
  })

  it('stays open while a post is in flight, so the same text cannot be sent twice, and refocuses the box after', async () => {
    const user = userEvent.setup()
    let fail: () => void = () => {}
    const onAddComment = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = () => reject(new Error("Couldn't add the comment. Try again."))
        }),
    )
    render(
      <CanopyCMSProvider>
        <FormRenderer {...props('content/a', onAddComment)} />
      </CanopyCMSProvider>,
    )
    await user.click(control('title'))
    await user.type(await screen.findByTestId('new-thread-textarea'), 'Slow')
    await user.click(screen.getByTestId('create-thread-button'))
    // Each way of closing is refused; checked past the popover's close transition.
    const stillOpen = async () => {
      await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect(screen.getByTestId('field-comment-title-popover')).toBeTruthy()
    }
    await user.keyboard('{Escape}')
    await stillOpen()
    await user.click(document.body)
    await stillOpen()
    await user.click(control('title'))
    await stillOpen()
    expect(onAddComment).toHaveBeenCalledTimes(1)

    // A failure leaves focus in the box, so Escape still reaches the popover.
    await act(async () => fail())
    expect(await screen.findByText("Couldn't add the comment. Try again.")).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('new-thread-textarea')),
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())
  })
})

describe('comment writes the popover can no longer show', () => {
  const props = (entryPath: string, extra: Partial<FormRendererProps> = {}) => ({
    fields: [{ name: 'title', type: 'string', label: 'Title' }] as FieldConfig[],
    value: { title: 'Hello' },
    onChange: () => {},
    currentEntryPath: entryPath,
    currentUserId: 'alice',
    canResolve: true,
    onAddComment: vi.fn(async () => {}),
    onResolveThread: vi.fn(async () => {}),
    ...extra,
  })
  const hanging = () => {
    const control = { fail: () => {} }
    const fn = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          control.fail = () => reject(new Error("Couldn't add the comment. Try again."))
        }),
    )
    return { fn, control }
  }

  it('refuses Cancel while a new thread is posting', async () => {
    const user = userEvent.setup()
    const { fn } = hanging()
    render(
      <CanopyCMSProvider>
        <FormRenderer {...props(ENTRY, { onAddComment: fn, comments: [thread('t1', 'title')] })} />
      </CanopyCMSProvider>,
    )
    await user.click(control('title'))
    await user.click(await screen.findByTestId('new-thread-button'))
    await user.type(screen.getByTestId('new-thread-textarea'), 'Dup')
    await user.click(screen.getByTestId('create-thread-button'))
    expect(screen.getByRole('button', { name: 'Cancel' }).matches(':disabled')).toBe(true)
  })

  it('reports a failure that lands after another entry opened', async () => {
    const user = userEvent.setup()
    showNotification.mockClear()
    const { fn, control: post } = hanging()
    const { rerender } = render(
      <CanopyCMSProvider>
        <FormRenderer {...props('content/a', { onAddComment: fn })} />
      </CanopyCMSProvider>,
    )
    await user.click(control('title'))
    await user.type(await screen.findByTestId('new-thread-textarea'), 'Lost?')
    await user.click(screen.getByTestId('create-thread-button'))
    rerender(
      <CanopyCMSProvider>
        <FormRenderer {...props('content/b', { onAddComment: fn })} />
      </CanopyCMSProvider>,
    )
    await act(async () => post.fail())
    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'red', message: "Couldn't add the comment. Try again." }),
    )
  })

  it('drops an entry-level draft when the entry changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <CanopyCMSProvider>
        <FormRenderer {...props('content/a')} />
      </CanopyCMSProvider>,
    )
    await user.click(screen.getByTestId('entry-comment-button'))
    await user.type(await screen.findByTestId('new-thread-textarea'), 'Entry draft')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('entry-comment-button-popover')).toBeNull())
    rerender(
      <CanopyCMSProvider>
        <FormRenderer {...props('content/b')} />
      </CanopyCMSProvider>,
    )
    await user.click(screen.getByTestId('entry-comment-button'))
    expect(((await screen.findByTestId('new-thread-textarea')) as HTMLTextAreaElement).value).toBe(
      '',
    )
  })

  it('puts focus back in the reply box when a reply fails', async () => {
    const user = userEvent.setup()
    render(
      <CanopyCMSProvider>
        <FormRenderer
          {...props(ENTRY, {
            comments: [thread('t1', 'title')],
            onAddComment: vi.fn(async () => {
              throw new Error("Couldn't add the comment. Try again.")
            }),
          })}
        />
      </CanopyCMSProvider>,
    )
    await user.click(control('title'))
    const popover = await screen.findByTestId('field-comment-title-popover')
    await user.click(within(popover).getByTestId('reply-thread-button'))
    const box = within(popover).getByRole('textbox', { name: 'Reply to this thread' })
    await user.type(box, 'Nope')
    await user.click(within(popover).getByTestId('submit-reply-button'))
    expect(await within(popover).findByText("Couldn't add the comment. Try again.")).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(box))
  })
})

describe('the form keyboard route to field comments', () => {
  const pressShortcut = (user: ReturnType<typeof userEvent.setup>) =>
    user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}')
  const menuButton = () => screen.getByTestId('form-comments-menu-button')

  it("opens the focused field's popover on Mod+Alt+M, and Escape returns focus to the input", async () => {
    const user = userEvent.setup()
    renderForm({ comments: [thread('t1', 'meta.summary')] })
    const input = screen.getByLabelText('Summary')
    act(() => input.focus())
    await pressShortcut(user)
    const popover = await screen.findByTestId('field-comment-meta.summary-popover')
    expect(within(popover).getByText('Comment in t1')).toBeTruthy()
    expect(screen.queryByTestId('form-comments-menu')).toBeNull()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByTestId('field-comment-meta.summary-popover')).toBeNull(),
    )
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it('opens the menu on Mod+Alt+M when focus is outside every field', async () => {
    const user = userEvent.setup()
    renderForm()
    await pressShortcut(user)
    expect(await screen.findByTestId('form-comments-menu')).toBeTruthy()
    expect(screen.queryByTestId('field-comment-title-popover')).toBeNull()
  })

  it('leaves AltGr+M alone where it types another character', async () => {
    renderForm()
    const input = screen.getByLabelText('Title')
    act(() => input.focus())
    // AltGr reads as Ctrl+Alt; on a layout where AltGr+M types "µ", `key` is that character.
    const event = new KeyboardEvent('keydown', {
      key: 'µ',
      code: 'KeyM',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      input.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    await expect(
      screen.findByTestId('field-comment-title-popover', {}, { timeout: 300 }),
    ).rejects.toThrow()
  })

  it('matches ⌘⌥M by key position on macOS, where ⌥ changes the character', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    try {
      renderForm()
      const input = screen.getByLabelText('Title')
      act(() => input.focus())
      const event = new KeyboardEvent('keydown', {
        key: 'µ',
        code: 'KeyM',
        metaKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      })
      act(() => {
        input.dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(true)
      expect(await screen.findByTestId('field-comment-title-popover')).toBeTruthy()
    } finally {
      platform.mockRestore()
    }
  })

  it('matches Ctrl+Alt+M by key position on a layout whose letters are not Latin', async () => {
    renderForm()
    const input = screen.getByLabelText('Title')
    act(() => input.focus())
    const event = new KeyboardEvent('keydown', {
      key: 'ь',
      code: 'KeyM',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      input.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(await screen.findByTestId('field-comment-title-popover')).toBeTruthy()
  })

  it('leaves Mod+Alt+M alone while a modal dialog is open', async () => {
    const user = userEvent.setup()
    renderForm()
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    try {
      await pressShortcut(user)
      await expect(
        screen.findByTestId('form-comments-menu', {}, { timeout: 300 }),
      ).rejects.toThrow()
    } finally {
      modal.remove()
    }
  })

  it('lists the fields with threads in form order, resolved ones included, and opens the chosen one', async () => {
    const user = userEvent.setup()
    renderForm({
      comments: [
        thread('t1', 'links[0].href', { resolved: true }),
        thread('t2', 'title'),
        thread('t3', 'title'),
        thread('e1', undefined, { type: 'entry' }),
        // On a field no longer in the form: neither listed nor counted.
        thread('t4', 'links[5].href'),
      ],
    })
    expect(menuButton().getAttribute('aria-label')).toBe('Field comments (2 open threads)')
    expect(menuButton().getAttribute('aria-haspopup')).toBe('menu')
    await user.click(menuButton())
    const menu = await screen.findByTestId('form-comments-menu')
    expect(menuButton().getAttribute('aria-expanded')).toBe('true')
    const withThreads = within(menu)
      .getAllByRole('menuitem')
      .filter((item) => item.dataset.testid?.startsWith('form-comments-field-'))
    expect(withThreads.map((item) => item.textContent)).toEqual([
      'Title2 open threads',
      'Links › /a › HrefResolved',
    ])
    await user.click(withThreads[1])
    const popover = await screen.findByTestId('field-comment-links[0].href-popover')
    expect(within(popover).getByText('Comment in t1')).toBeTruthy()
  })

  it('lists every field, so one with nothing focusable of its own can be commented on', async () => {
    const user = userEvent.setup()
    const { onAddComment } = renderForm({ readOnly: true })
    await user.click(menuButton())
    const menu = await screen.findByTestId('form-comments-menu')
    expect(within(menu).getByText('Comment on a field')).toBeTruthy()
    const items = within(menu)
      .getAllByRole('menuitem')
      .filter((item) => item.dataset.testid?.startsWith('form-comments-any-field-'))
    expect(items.map((item) => item.textContent)).toEqual([
      'Title',
      'Meta',
      'Meta › Summary',
      'Links',
      'Links › /a › Href',
    ])
    await user.click(within(menu).getByTestId('form-comments-any-field-meta'))
    const popover = await screen.findByTestId('field-comment-meta-popover')
    await user.type(within(popover).getByTestId('new-thread-textarea'), 'Whole group')
    await user.click(within(popover).getByTestId('create-thread-button'))
    expect(onAddComment).toHaveBeenCalledWith('Whole group', 'field', ENTRY, 'meta', undefined)
  })

  it('returns focus to the menu button when a popover opened from the menu closes', async () => {
    const user = userEvent.setup()
    renderForm({ comments: [thread('t1', 'title')] })
    await user.click(menuButton())
    await user.click(await screen.findByTestId('form-comments-field-title'))
    await screen.findByTestId('field-comment-title-popover')
    const scrollButton = vi.fn()
    menuButton().scrollIntoView = scrollButton
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(menuButton()))
    // The button may have scrolled out of view, so focus brings it back.
    expect(scrollButton).toHaveBeenCalledWith({ block: 'nearest' })
    // Opened from its own control next, it returns focus there instead, also when a click on
    // the page, not Escape, closes it.
    await user.click(control('title'))
    await screen.findByTestId('field-comment-title-popover')
    await user.click(document.body)
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(control('title')))
  })

  it('leaves focus where a click put it when a popover opened from the menu closes', async () => {
    const user = userEvent.setup()
    renderForm({ comments: [thread('t1', 'title')] })
    await user.click(menuButton())
    await user.click(await screen.findByTestId('form-comments-field-title'))
    await screen.findByTestId('field-comment-title-popover')
    const scrollButton = vi.fn()
    menuButton().scrollIntoView = scrollButton
    // A click on a blank part of the form, which takes no focus.
    const form = document.querySelector<HTMLElement>('[data-form-renderer]')
    if (!form) throw new Error('no form')
    await user.click(form)
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(document.activeElement).not.toBe(menuButton())
    expect(scrollButton).not.toHaveBeenCalled()
  })

  it('starts a thread on the field last focused', async () => {
    const user = userEvent.setup()
    const { onAddComment } = renderForm()
    act(() => screen.getByLabelText('Summary').focus())
    await user.click(menuButton())
    const menu = await screen.findByTestId('form-comments-menu')
    const item = within(menu).getByTestId('form-comments-comment-on-focused')
    expect(item.textContent).toBe('Comment on Meta › Summary')
    expect(within(menu).getByText('Comment on another field')).toBeTruthy()
    // It isn't offered twice.
    expect(within(menu).queryByTestId('form-comments-any-field-meta.summary')).toBeNull()
    await user.click(item)
    const popover = await screen.findByTestId('field-comment-meta.summary-popover')
    await user.type(within(popover).getByTestId('new-thread-textarea'), 'Tighten this')
    await user.click(within(popover).getByTestId('create-thread-button'))
    expect(onAddComment).toHaveBeenCalledWith(
      'Tighten this',
      'field',
      ENTRY,
      'meta.summary',
      undefined,
    )
  })

  it("names the shortcut in the controls' tooltips and aria-keyshortcuts", async () => {
    const user = userEvent.setup()
    renderForm({ comments: [thread('t1', 'meta.summary')] })
    expect(control('title').getAttribute('aria-keyshortcuts')).toBe('Control+Alt+M')
    expect(menuButton().getAttribute('aria-keyshortcuts')).toBe('Control+Alt+M')
    await user.hover(control('title'))
    expect(await screen.findByText('Comment on Title (Ctrl+Alt+M)')).toBeTruthy()
    await user.hover(control('meta.summary'))
    expect(
      await screen.findByText('Comment on Meta › Summary (1 open thread, Ctrl+Alt+M)'),
    ).toBeTruthy()
    await user.hover(menuButton())
    expect(await screen.findByText('Field comments (Ctrl+Alt+M)')).toBeTruthy()
  })
})

describe('field comment popover placement', () => {
  /** Lays a field's anchors out at `top`..`bottom` in an 800px-tall window. */
  const layOut = (path: string, top: number, bottom: number) => {
    const wrapper = document.querySelector(`[data-field-comments][data-canopy-field="${path}"]`)
    const rect = (y: number) => ({ top: y, bottom: y, left: 0, right: 600, width: 600, height: 0 })
    const above = wrapper?.querySelector<HTMLElement>(':scope > [data-comment-anchor="above"]')
    const below = wrapper?.querySelector<HTMLElement>(':scope > [data-comment-anchor="below"]')
    if (!above || !below) throw new Error(`no anchors for ${path}`)
    vi.spyOn(above, 'getBoundingClientRect').mockReturnValue(rect(top) as DOMRect)
    vi.spyOn(below, 'getBoundingClientRect').mockReturnValue(rect(bottom) as DOMRect)
    return { above, below }
  }
  beforeEach(() => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
  })

  it('opens a short field below its input, and toggles from its control', async () => {
    const user = userEvent.setup()
    renderForm()
    layOut('title', 100, 160)
    await user.click(control('title'))
    const popover = await screen.findByTestId('field-comment-title-popover')
    expect(popover.getAttribute('data-position')).toBe('bottom-start')
    expect(popover.getAttribute('role')).toBe('dialog')
    expect(control('title').getAttribute('aria-controls')).toBe(popover.id)
    // A second click on the control closes it rather than reopening it.
    await user.click(control('title'))
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())
    await user.click(control('title'))
    await screen.findByTestId('field-comment-title-popover')
    await user.click(screen.getByLabelText('Summary'))
    await waitFor(() => expect(screen.queryByTestId('field-comment-title-popover')).toBeNull())
  })

  it('opens above the label row when there is no room below, never over the input', async () => {
    const user = userEvent.setup()
    renderForm()
    const { below } = layOut('title', 600, 660)
    const scroll = vi.fn()
    below.scrollIntoView = scroll
    await user.click(control('title'))
    const popover = await screen.findByTestId('field-comment-title-popover')
    expect(popover.getAttribute('data-position')).toBe('top-start')
    expect(scroll).not.toHaveBeenCalled()
  })

  it('opens a group above its label row, since its end is far from the control', async () => {
    const user = userEvent.setup()
    renderForm()
    layOut('meta', 400, 520)
    await user.click(control('meta'))
    const popover = await screen.findByTestId('field-comment-meta-popover')
    expect(popover.getAttribute('data-position')).toBe('top-start')
  })

  it('leaves the scroll to the popover when a jump both focuses and highlights the field', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      renderForm({
        comments: [thread('t1', 'title')],
        focusedFieldPath: 'title',
        highlightThreadId: 't1',
      })
      expect(scroll).not.toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    } finally {
      scroll.mockRestore()
    }
  })

  it('opens a group below when only below has room', async () => {
    const user = userEvent.setup()
    renderForm()
    layOut('meta', 40, 160)
    await user.click(control('meta'))
    const popover = await screen.findByTestId('field-comment-meta-popover')
    expect(popover.getAttribute('data-position')).toBe('bottom-start')
  })

  it('scrolls a field into the middle when neither side has room', async () => {
    const user = userEvent.setup()
    renderForm()
    const { below } = layOut('title', 100, 700)
    below.scrollIntoView = vi.fn()
    const above = document.querySelector<HTMLElement>(
      '[data-canopy-field="title"] > [data-comment-anchor="above"]',
    )
    const scrollAbove = vi.fn()
    if (above) above.scrollIntoView = scrollAbove
    await user.click(control('title'))
    await screen.findByTestId('field-comment-title-popover')
    // 600px tall is a tall field: it prefers above its label row, and scrolls that into view.
    expect(scrollAbove).toHaveBeenCalledWith({ block: 'center' })
  })
})

describe('field comment popover placement, when a highlight opens it', () => {
  /** Lays every field's anchors out by path, before render, and records anchor scrolls. */
  const stubLayout = (rects: Record<string, [number, number]>) => {
    const anchorRect = (el: Element): [number, number] | undefined => {
      const side = el.getAttribute('data-comment-anchor')
      const path = el.parentElement?.getAttribute('data-canopy-field')
      const rect = path ? rects[path] : undefined
      if (!side || !rect) return undefined
      return [side === 'above' ? rect[0] : rect[1], side === 'above' ? rect[0] : rect[1]]
    }
    const original = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const y = anchorRect(this)
      if (!y) return original.call(this)
      return { top: y[0], bottom: y[1], left: 0, right: 600, width: 600, height: 0 } as DOMRect
    })
    const scrolled: Array<{ anchor: string | null; field: string | null | undefined }> = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push({
        anchor: this.getAttribute('data-comment-anchor'),
        field: this.parentElement?.getAttribute('data-canopy-field'),
      })
    })
    return scrolled
  }
  /** Renders the form with props that can change, as the editor re-renders it. */
  const renderStateless = (props: Partial<FormRendererProps>) => {
    const ui = (next: Partial<FormRendererProps>) => (
      <CanopyCMSProvider>
        <FormRenderer
          fields={fields}
          value={{ title: 'Hello', meta: { summary: 'S' }, links: [{ href: '/a' }] }}
          onChange={() => {}}
          currentEntryPath={ENTRY}
          currentUserId="alice"
          canResolve
          onAddComment={async () => {}}
          onResolveThread={async () => {}}
          {...next}
        />
      </CanopyCMSProvider>
    )
    const result = render(ui(props))
    return { rerender: (next: Partial<FormRendererProps>) => result.rerender(ui(next)) }
  }
  beforeEach(() => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('places and scrolls a field that mounts already highlighted', async () => {
    const scrolled = stubLayout({ title: [2000, 2060] })
    renderForm({ comments: [thread('t1', 'title')], highlightThreadId: 't1' })
    await screen.findByTestId('field-comment-title-popover')
    expect(scrolled).toContainEqual({ anchor: 'below', field: 'title' })
  })

  it("scrolls a highlighted field even when it fits, overriding a jump's smooth scroll", async () => {
    const scrolled = stubLayout({ title: [100, 160] })
    const props = { comments: [thread('t1', 'title')] }
    const { rerender } = renderStateless(props)
    rerender({ ...props, highlightThreadId: 't1' })
    await screen.findByTestId('field-comment-title-popover')
    expect(scrolled).toContainEqual({ anchor: 'below', field: 'title' })
  })
})
