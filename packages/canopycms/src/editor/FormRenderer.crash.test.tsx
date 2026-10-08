import { act, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import React, { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { FieldConfig } from '../config'
import type { CustomFieldRenderers, FormValue } from './FormRenderer'
import { FormRenderer } from './FormRenderer'
import { CanopyCMSProvider } from './theme'
import { mockConsole, type MockConsole } from '../test-utils/console-spy'
import { silenceReportedRenderErrors } from '../test-utils/render-errors'

const fields: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  { name: 'settings', type: 'code', label: 'Settings' },
]

/** A `code` field renderer that throws while `crash.now` is set, keeping its last onChange. */
const crash = { now: false, onChange: (_v: unknown) => {} }
const crashingRenderers: CustomFieldRenderers = {
  code: ({ onChange, value }) => {
    crash.onChange = onChange
    if (crash.now) throw new Error('settings exploded')
    return <div data-testid="settings-control">{String(value)}</div>
  },
}

const Form: React.FC<{
  initialValue: FormValue
  entry?: string
  branch?: string
  customRenderers?: CustomFieldRenderers
}> = ({ initialValue, entry = 'content/a', branch = 'main', customRenderers }) => {
  const [value, setValue] = useState<FormValue>(initialValue)
  return (
    <CanopyCMSProvider>
      <FormRenderer
        fields={fields}
        value={value}
        onChange={setValue}
        customRenderers={customRenderers ?? crashingRenderers}
        currentEntryPath={entry}
        branch={branch}
      />
      <pre data-testid="form-state">{JSON.stringify(value)}</pre>
    </CanopyCMSProvider>
  )
}

const formState = (): FormValue => JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')

describe('FormRenderer field crash containment', () => {
  let consoleSpy: MockConsole
  let unsilence: () => void

  beforeEach(() => {
    crash.now = false
    consoleSpy = mockConsole()
    unsilence = silenceReportedRenderErrors()
  })

  afterEach(() => {
    unsilence()
    consoleSpy.restore()
  })

  it('shows a field that throws as an inline error with its value, and the other fields keep working', async () => {
    crash.now = true
    render(<Form initialValue={{ title: 'Hello', settings: '{"a":1}' }} />)

    const fallback = screen.getByTestId('field-crash-fallback')
    expect(fallback.textContent).toContain('Settings')
    expect(fallback.textContent).toContain("This field couldn't be shown")
    expect(screen.getByTestId('field-crash-value').textContent).toBe('{"a":1}')
    expect(screen.getByTestId('copy-error-details')).toBeTruthy()
    expect(consoleSpy).toHaveErrored('[canopycms] editor error caught (field settings)')

    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Title' }), '!')
    expect(formState()).toEqual({ title: 'Hello!', settings: '{"a":1}' })
  })

  it('drops an edit a crashed field emits from a callback it held before crashing', async () => {
    render(<Form initialValue={{ title: 'Hello', settings: 'kept' }} />)
    expect(screen.getByTestId('settings-control')).toBeTruthy()
    const heldOnChange = crash.onChange

    crash.now = true
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Title' }), '!')
    expect(screen.getByTestId('field-crash-fallback')).toBeTruthy()

    act(() => heldOnChange('changed behind the fallback'))
    expect(formState()).toEqual({ title: 'Hello!', settings: 'kept' })
  })

  it('drops an edit the crashed render scheduled, even once the author has moved to another entry', async () => {
    crash.now = true
    const initialValue = { title: 'Hello', settings: 'kept' }
    const { rerender } = render(<Form initialValue={initialValue} />)
    const heldFromCrash = crash.onChange
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Title' }), '!')

    crash.now = false
    rerender(<Form initialValue={initialValue} entry="content/b" />)
    act(() => heldFromCrash('late'))

    expect(formState()).toEqual({ title: 'Hello!', settings: 'kept' })
  })

  it('keeps a healthy list item editable after the crashed item before it is removed', async () => {
    const listFields: FieldConfig[] = [
      {
        name: 'items',
        type: 'object',
        label: 'Items',
        list: true,
        fields: [{ name: 'settings', type: 'code', label: 'Settings' }],
      },
    ]
    const List: React.FC = () => {
      const [value, setValue] = useState<FormValue>({
        items: [{ settings: 'boom' }, { settings: 'b' }, { settings: 'c' }],
      })
      return (
        <CanopyCMSProvider>
          <FormRenderer
            fields={listFields}
            value={value}
            onChange={setValue}
            customRenderers={{
              code: ({ value: v, onChange }) => {
                if (v === 'boom') throw new Error('item exploded')
                return (
                  <button
                    type="button"
                    data-testid={`edit-${String(v)}`}
                    onClick={() => onChange(`${String(v)}!`)}
                  >
                    {String(v)}
                  </button>
                )
              },
            }}
          />
          <pre data-testid="form-state">{JSON.stringify(value)}</pre>
        </CanopyCMSProvider>
      )
    }
    render(<List />)
    expect(screen.getByTestId('field-crash-fallback')).toBeTruthy()

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    expect(screen.queryByTestId('field-crash-fallback')).toBeNull()
    await user.click(screen.getByTestId('edit-b'))

    expect(formState()).toEqual({ items: [{ settings: 'b!' }, { settings: 'c' }] })
  })

  it.each([
    ['entry', { entry: 'content/b' }],
    ['branch', { branch: 'feature' }],
  ])('shows a crashed field again when the %s changes', (_case, next) => {
    crash.now = true
    const initialValue = { title: 'Hello', settings: 'kept' }
    const { rerender } = render(<Form initialValue={initialValue} />)
    expect(screen.getByTestId('field-crash-fallback')).toBeTruthy()

    crash.now = false
    rerender(<Form initialValue={initialValue} />)
    expect(screen.getByTestId('field-crash-fallback')).toBeTruthy()

    rerender(<Form initialValue={initialValue} {...next} />)
    expect(screen.queryByTestId('field-crash-fallback')).toBeNull()
    expect(screen.getByTestId('settings-control')).toBeTruthy()

    act(() => crash.onChange('edited after the reset'))
    expect(formState().settings).toBe('edited after the reset')

    // Back where it crashed, the field is shown afresh and its edits flow again.
    rerender(<Form initialValue={initialValue} />)
    expect(screen.getByTestId('settings-control')).toBeTruthy()
    act(() => crash.onChange('edited back where it crashed'))
    expect(formState().settings).toBe('edited back where it crashed')
  })

  it("keeps a healthy block editable after it moves into a crashed block's place", async () => {
    const blockFields: FieldConfig[] = [
      {
        name: 'blocks',
        type: 'block',
        label: 'Blocks',
        templates: [
          { name: 'panel', label: 'Panel', fields: [{ name: 'settings', type: 'code' }] },
        ],
      },
    ]
    const Blocks: React.FC = () => {
      const [value, setValue] = useState<FormValue>({
        blocks: [
          { template: 'panel', value: { settings: 'boom' } },
          { template: 'panel', value: { settings: 'healthy' } },
        ],
      })
      return (
        <CanopyCMSProvider>
          <FormRenderer
            fields={blockFields}
            value={value}
            onChange={setValue}
            customRenderers={{
              code: ({ value: v, onChange }) => {
                if (v === 'boom') throw new Error('panel exploded')
                return (
                  <button
                    type="button"
                    data-testid="edit-settings"
                    onClick={() => onChange('edited')}
                  >
                    {String(v)}
                  </button>
                )
              },
            }}
          />
          <pre data-testid="form-state">{JSON.stringify(value)}</pre>
        </CanopyCMSProvider>
      )
    }
    render(<Blocks />)
    expect(screen.getByTestId('field-crash-fallback')).toBeTruthy()

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Move block up' })[1])
    await user.click(screen.getByTestId('edit-settings'))

    const blocks = formState().blocks as Array<{ value: { settings: string } }>
    expect(blocks.map((b) => b.value.settings)).toEqual(['edited', 'boom'])
    expect(screen.getByTestId('field-crash-fallback')).toBeTruthy()
  })

  describe('object-list item keys', () => {
    const listFields: FieldConfig[] = [
      {
        name: 'items',
        type: 'object',
        label: 'Items',
        list: true,
        fields: [{ name: 'settings', type: 'code', label: 'Settings' }],
      },
    ]
    const mounts = { count: 0 }
    const Counted: React.FC = () => {
      React.useEffect(() => {
        mounts.count += 1
      }, [])
      return null
    }
    const List: React.FC<{ initial: FormValue }> = ({ initial }) => {
      const [value, setValue] = useState<FormValue>(initial)
      return (
        <CanopyCMSProvider>
          <FormRenderer
            fields={listFields}
            value={value}
            onChange={setValue}
            customRenderers={{
              code: ({ value: v, onChange }) => (
                <>
                  <Counted />
                  <button
                    type="button"
                    data-testid={`edit-${String(v)}`}
                    onClick={() => onChange(`${String(v)}!`)}
                  >
                    {String(v)}
                  </button>
                </>
              ),
            }}
          />
          <button type="button" onClick={() => setValue(JSON.parse(JSON.stringify(value)))}>
            replace with saved copy
          </button>
          <pre data-testid="form-state">{JSON.stringify(value)}</pre>
        </CanopyCMSProvider>
      )
    }

    beforeEach(() => {
      mounts.count = 0
    })

    it('keeps items mounted when the list is replaced by an equal copy, as after Save', async () => {
      render(<List initial={{ items: [{ settings: 'a' }, { settings: 'b' }] }} />)
      expect(mounts.count).toBe(2)

      await userEvent.setup().click(screen.getByRole('button', { name: 'replace with saved copy' }))

      expect(mounts.count).toBe(2)
    })

    it('keeps the existing items mounted when an item is added', async () => {
      render(<List initial={{ items: [{ settings: 'a' }, { settings: 'b' }] }} />)

      await userEvent.setup().click(screen.getByRole('button', { name: 'Add item' }))

      expect(formState().items).toHaveLength(3)
      expect(mounts.count).toBe(3)
    })

    it('gives the same object listed twice two keys, through an edit of the second', async () => {
      const shared = { settings: 'a' }
      render(<List initial={{ items: [shared, shared] }} />)
      const user = userEvent.setup()

      await user.click(screen.getAllByTestId('edit-a')[0])
      await user.click(screen.getByTestId('edit-a'))

      expect(formState()).toEqual({ items: [{ settings: 'a!' }, { settings: 'a!' }] })
      expect(mounts.count).toBe(2)
      expect(consoleSpy.all().error.some((m) => m.includes('same key'))).toBe(false)
    })
  })

  it('shows a crashed markdown field holding a non-string value read-only', () => {
    const Markdown: React.FC = () => (
      <CanopyCMSProvider>
        <FormRenderer
          fields={[{ name: 'body', type: 'markdown', label: 'Body' }]}
          value={{ body: { not: 'text' } }}
          onChange={() => {}}
          customRenderers={{
            markdown: () => {
              throw new Error('markdown exploded')
            },
          }}
        />
      </CanopyCMSProvider>
    )
    render(<Markdown />)

    expect(screen.getByTestId('field-crash-value').textContent).toContain('"not": "text"')
    expect(screen.queryByTestId('markdown-source-editor')).toBeNull()
  })

  it('opens a crashed markdown field as editable source', async () => {
    const markdownFields: FieldConfig[] = [{ name: 'body', type: 'markdown', label: 'Body' }]
    const Markdown: React.FC = () => {
      const [value, setValue] = useState<FormValue>({ body: '# Hello' })
      return (
        <CanopyCMSProvider>
          <FormRenderer
            fields={markdownFields}
            value={value}
            onChange={setValue}
            customRenderers={{
              markdown: () => {
                throw new Error('markdown exploded')
              },
            }}
          />
          <pre data-testid="form-state">{JSON.stringify(value)}</pre>
        </CanopyCMSProvider>
      )
    }
    render(<Markdown />)

    expect(screen.getByTestId('markdown-source-fallback').textContent).toContain(
      "couldn't be opened in the visual editor",
    )
    const source = screen.getByTestId<HTMLTextAreaElement>('markdown-source-editor')
    expect(source.value).toBe('# Hello')

    await userEvent.setup().type(source, '!')
    expect(formState()).toEqual({ body: '# Hello!' })
  })
})
