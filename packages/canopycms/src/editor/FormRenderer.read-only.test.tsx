/**
 * A read-only form takes no edit through any field type: every control is read-only and inside a
 * disabled fence, no add/remove/reorder affordance renders, and `onChange` is never called,
 * MDXEditor's mount-time normalisation included. Comments stay usable.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

// See FormRenderer.test.tsx: preloading MarkdownField's lazy chunk keeps mount timing honest.
import '@mdxeditor/editor'

import type { FieldConfig } from '../config'
import type { CustomFieldRenderProps, FormRendererProps, FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { CanopyCMSProvider } from './theme'
import type { MockApiClient } from '../api/__test__/mock-client'
import { setupMockApiClient, createApiClientWrapper } from './hooks/__test__/test-utils'
import { mockConsole } from '../test-utils/console-spy'
import { silenceReportedRenderErrors } from '../test-utils/render-errors'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, createApiClient: vi.fn() }
})

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

let mockClient: MockApiClient

beforeEach(async () => {
  mockClient = await setupMockApiClient()
})

afterEach(() => cleanup())

const renderReadOnly = (
  fields: FieldConfig[],
  value: FormValue,
  extra: Partial<FormRendererProps> = {},
) => {
  const onChange = vi.fn()
  const Wrapper = createApiClientWrapper(mockClient)
  const view = render(
    <CanopyCMSProvider>
      <Wrapper>
        <FormRenderer fields={fields} value={value} onChange={onChange} readOnly {...extra} />
      </Wrapper>
    </CanopyCMSProvider>,
  )
  return { onChange, ...view }
}

/** Read-only by the field's own prop, and disabled by the fence around it. */
const expectLocked = (el: HTMLElement) => {
  expect((el as HTMLInputElement).readOnly).toBe(true)
  expect(el.matches(':disabled')).toBe(true)
}

describe('FormRenderer readOnly', () => {
  it('string: the input is locked and a change writes nothing', () => {
    const { onChange } = renderReadOnly([{ name: 'title', type: 'string', label: 'Title' }], {
      title: 'Hello',
    })
    const input = screen.getByRole('textbox', { name: 'Title' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: 'Changed' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('string list: the tags input is locked and Enter adds nothing', () => {
    const { onChange } = renderReadOnly(
      [{ name: 'tags', type: 'string', label: 'Tags', list: true }],
      { tags: ['one'] },
    )
    const input = screen.getByRole('textbox', { name: 'Tags' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: 'two' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('boolean: the switch is disabled and a click writes nothing', () => {
    const { onChange } = renderReadOnly([{ name: 'draft', type: 'boolean', label: 'Draft' }], {
      draft: false,
    })
    const input = screen.getByRole('switch', { name: 'Draft' }) as HTMLInputElement
    expect(input.disabled).toBe(true)
    fireEvent.click(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('number: the input is locked and a change writes nothing', () => {
    const { onChange } = renderReadOnly([{ name: 'count', type: 'number', label: 'Count' }], {
      count: 3,
    })
    const input = screen.getByRole('textbox', { name: 'Count' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: '4' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('number list: the tags input is locked and Enter adds nothing', () => {
    const { onChange } = renderReadOnly(
      [{ name: 'sizes', type: 'number', label: 'Sizes', list: true }],
      { sizes: [1] },
    )
    const input = screen.getByRole('textbox', { name: 'Sizes' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('datetime: the input is locked and a change writes nothing', () => {
    const { onChange, container } = renderReadOnly(
      [{ name: 'publishedAt', type: 'datetime', label: 'Published' }],
      { publishedAt: '2024-01-02T03:04:05.000Z' },
    )
    const input = container.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    expectLocked(input)
    fireEvent.change(input, { target: { value: '2025-01-01T00:00' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('markdown: MDXEditor mounts read-only, offers no source toggle, and emits nothing', async () => {
    const { onChange, container } = renderReadOnly(
      [{ name: 'body', type: 'markdown', label: 'Body' }],
      // A list MDXEditor re-serialises on mount ("*" becomes "-").
      { body: '* one\n* two\n' },
    )
    await waitFor(() => {
      expect(container.querySelector('.canopy-mdx-content')).not.toBeNull()
    })
    const content = container.querySelector('.canopy-mdx-content')!
    expect(content.getAttribute('contenteditable')).toBe('false')
    expect(screen.queryByTestId('markdown-mode-toggle')).toBeNull()
    // Let any mount-time normalisation settle before asserting nothing was emitted.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('select: the input is locked and a change writes nothing', () => {
    const { onChange } = renderReadOnly(
      [{ name: 'colour', type: 'select', label: 'Colour', options: ['red', 'blue'] }],
      { colour: 'red' },
    )
    const input = screen.getByRole('textbox', { name: 'Colour' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: 'blue' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('multi-select: the input is locked and its pills have no remove button', () => {
    const { onChange, container } = renderReadOnly(
      [{ name: 'colours', type: 'select', label: 'Colours', list: true, options: ['red', 'blue'] }],
      { colours: ['red'] },
    )
    const input = screen.getByRole('textbox', { name: 'Colours' })
    expectLocked(input)
    expect(container.querySelector('.mantine-Pill-remove')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reference: the input is locked and a change writes nothing', () => {
    const { onChange } = renderReadOnly(
      [
        {
          name: 'author',
          type: 'reference',
          label: 'Author',
          collections: ['people'],
          options: [{ label: 'Ada', value: 'ada00000000a' }],
        },
      ],
      { author: 'ada00000000a' },
    )
    const input = screen.getByRole('textbox', { name: 'Author' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: 'x' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('image (empty): no dropzone and no library picker', () => {
    renderReadOnly([{ name: 'hero', type: 'image', label: 'Hero' }], {})
    expect(screen.queryByTestId('image-field-dropzone-hero')).toBeNull()
    expect(screen.queryByTestId('image-field-browse-library-hero')).toBeNull()
    expect(screen.getByTestId('image-field-empty-hero')).toBeTruthy()
  })

  it('image (filled): alt text is locked; replace, crop and remove are absent', () => {
    const { onChange } = renderReadOnly(
      [{ name: 'hero', type: 'image', label: 'Hero', aspect: '16:9' }],
      { hero: { src: 'https://example.com/a.png', alt: 'A picture' } },
    )
    const alt = screen.getByTestId('image-field-alt-hero')
    expectLocked(alt)
    fireEvent.change(alt, { target: { value: 'New alt' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('image-field-replace-hero')).toBeNull()
    expect(screen.queryByTestId('image-field-crop-hero')).toBeNull()
    expect(screen.queryByTestId('image-field-remove-hero')).toBeNull()
  })

  it('block: no add, remove, move or drag; nested fields are locked', () => {
    const { onChange } = renderReadOnly(
      [
        {
          name: 'blocks',
          type: 'block',
          label: 'Sections',
          templates: [
            { name: 'hero', label: 'Hero', fields: [{ name: 'heading', type: 'string' }] },
          ],
        },
      ],
      {
        blocks: [
          { template: 'hero', value: { heading: 'First' } },
          { template: 'hero', value: { heading: 'Second' } },
        ],
      },
    )
    expect(screen.queryByRole('textbox', { name: 'Add block' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Move block up' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Move block down' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    const [first] = screen.getAllByRole('textbox', { name: 'heading' })
    expectLocked(first)
    fireEvent.change(first, { target: { value: 'Edited' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('object list: no add or remove; nested fields are locked', () => {
    const { onChange } = renderReadOnly(
      [
        {
          name: 'links',
          type: 'object',
          label: 'Links',
          list: true,
          fields: [{ name: 'href', type: 'string', label: 'Href' }],
        },
      ],
      { links: [{ href: '/a' }] },
    )
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    const input = screen.getByRole('textbox', { name: 'Href' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: '/b' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('object list (empty): says there are no items without inviting an add', () => {
    renderReadOnly(
      [
        {
          name: 'links',
          type: 'object',
          label: 'Links',
          list: true,
          fields: [{ name: 'href', type: 'string' }],
        },
      ],
      { links: [] },
    )
    expect(screen.getByText('No items.')).toBeTruthy()
  })

  it('object: an optional object with a value offers no Clear', () => {
    renderReadOnly(
      [
        {
          name: 'seo',
          type: 'object',
          label: 'SEO',
          fields: [{ name: 'title', type: 'string', label: 'SEO title' }],
        },
      ],
      { seo: { title: 'x' } },
    )
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expectLocked(screen.getByRole('textbox', { name: 'SEO title' }))
  })

  it('inline group: nested fields are locked and write nothing', () => {
    const { onChange } = renderReadOnly(
      [
        {
          name: 'meta',
          type: 'group',
          label: 'Meta',
          fields: [{ name: 'subtitle', type: 'string', label: 'Subtitle' }],
        },
      ],
      { subtitle: 'Sub' },
    )
    const input = screen.getByRole('textbox', { name: 'Subtitle' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: 'Edited' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('code: the textarea is locked and a change writes nothing', () => {
    const { onChange } = renderReadOnly([{ name: 'snippet', type: 'code', label: 'Snippet' }], {
      snippet: 'let a = 1',
    })
    const input = screen.getByRole('textbox', { name: 'Snippet' })
    expectLocked(input)
    fireEvent.change(input, { target: { value: 'let a = 2' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('custom renderer: gets readOnly, is fenced, and its onChange writes nothing', () => {
    let received: CustomFieldRenderProps | undefined
    const { onChange } = renderReadOnly(
      [{ name: 'colour', type: 'string', label: 'Colour' }],
      { colour: 'red' },
      {
        customRenderers: {
          string: (props) => {
            received = props
            // Ignores readOnly on purpose: the fence still disables it.
            return (
              <input
                aria-label="Custom colour"
                value={String(props.value)}
                onChange={(e) => props.onChange(e.currentTarget.value)}
              />
            )
          },
        },
      },
    )
    expect(received?.readOnly).toBe(true)
    const input = screen.getByRole('textbox', { name: 'Custom colour' })
    expect(input.matches(':disabled')).toBe(true)
    received?.onChange('blue')
    fireEvent.change(input, { target: { value: 'blue' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('crash fallback: a crashed markdown field shows its text read-only', () => {
    const consoleSpy = mockConsole()
    const unsilence = silenceReportedRenderErrors()
    onTestFinished(() => {
      unsilence()
      consoleSpy.restore()
    })
    const { onChange } = renderReadOnly(
      [{ name: 'body', type: 'markdown', label: 'Body' }],
      { body: 'Some text' },
      {
        customRenderers: {
          markdown: () => {
            throw new Error('boom')
          },
        },
      },
    )
    const fallback = screen.getByTestId('field-crash-fallback')
    const source = within(fallback).getByTestId('markdown-source-editor') as HTMLTextAreaElement
    expect(source.readOnly).toBe(true)
    fireEvent.change(source, { target: { value: 'Edited' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('comments stay usable on a read-only form', () => {
    renderReadOnly(
      [{ name: 'title', type: 'string', label: 'Title' }],
      { title: 'Hello' },
      {
        currentEntryPath: 'content/posts/hello',
        currentUserId: 'user-1',
        onAddComment: vi.fn(async () => {}),
        onResolveThread: vi.fn(async () => {}),
      },
    )
    const newComment = screen.getByTestId('field-new-comment-title')
    expect(newComment.matches(':disabled')).toBe(false)
  })
})
