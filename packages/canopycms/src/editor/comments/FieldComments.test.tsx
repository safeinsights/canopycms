import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    // The hidden control is still in the tab order: Shift+Tab from the input reaches it.
    act(() => screen.getByLabelText('Title').focus())
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(control('title'))
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

  it('shows a persistent badge counting open threads, and a plain icon for resolved-only ones', () => {
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
    expect(control('meta.summary').textContent).toBe('')
    expect(control('meta.summary').getAttribute('aria-label')).toBe('Comment on Meta › Summary')
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

    await user.type(within(threads[0]).getByRole('textbox'), 'Fixed it')
    await user.click(within(threads[0]).getByRole('button', { name: 'Reply' }))
    expect(onAddComment).toHaveBeenCalledWith('Fixed it', 'field', ENTRY, 'title', 'open')

    await user.click(within(threads[0]).getByTestId('resolve-thread-button'))
    expect(onResolveThread).toHaveBeenCalledWith('open')
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
    const box = within(popover).getByRole('textbox', { name: 'Reply to this thread' })
    await user.type(box, 'Nope')
    await user.click(within(popover).getByRole('button', { name: 'Reply' }))
    expect(await within(popover).findByText("Couldn't add the comment. Try again.")).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(box))
  })
})
