import { act, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { CommentThread } from '../../comment-store'
import type { FieldConfig } from '../../config'
import { FormRenderer, type FormRendererProps } from '../FormRenderer'
import { TextField } from '../fields/TextField'
import { FieldCommentContext } from './field-comment-context'
import { CanopyCMSProvider } from '../theme'

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

  it('shows a persistent badge counting open threads; resolved ones leave the icon', () => {
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
    expect(isRevealed(control('meta.summary'))).toBe(false)
  })

  it('opens a popover with the threads, open ones first, with reply and Resolve', async () => {
    const user = userEvent.setup()
    const { onAddComment, onResolveThread } = renderForm({
      comments: [thread('old', 'title', { resolved: true }), thread('open', 'title')],
    })
    await user.click(control('title'))
    const popover = await screen.findByTestId('field-comment-title-popover')
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
