import React, { Suspense, useId, useRef, useCallback, useEffect } from 'react'

import { Text, Textarea } from '@mantine/core'

import type { MDXEditorMethods } from '@mdxeditor/editor'

export interface MarkdownFieldProps {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
}

const MDXEditorLazy = React.lazy(async () => {
  const [
    { MDXEditor },
    {
      headingsPlugin,
      listsPlugin,
      quotePlugin,
      thematicBreakPlugin,
      markdownShortcutPlugin,
      linkPlugin,
      linkDialogPlugin,
      tablePlugin,
      toolbarPlugin,
      codeBlockPlugin,
      codeMirrorPlugin,
      BoldItalicUnderlineToggles,
      BlockTypeSelect,
      ListsToggle,
      CreateLink,
      InsertTable,
      InsertThematicBreak,
      CodeToggle,
      InsertCodeBlock,
      UndoRedo,
      Separator,
    },
  ] = await Promise.all([
    import('@mdxeditor/editor'),
    import('@mdxeditor/editor'),
  ])

  const WrappedEditor: React.FC<{
    markdown: string
    onChange: (value: string) => void
    editorRef?: React.Ref<MDXEditorMethods>
  }> = ({ markdown, onChange, editorRef }) => {
    return (
      <MDXEditor
        ref={editorRef}
        markdown={markdown}
        onChange={onChange}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          markdownShortcutPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          tablePlugin(),
          codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
          codeMirrorPlugin({
            codeBlockLanguages: {
              '': 'Plain text',
              js: 'JavaScript',
              ts: 'TypeScript',
              tsx: 'TSX',
              jsx: 'JSX',
              css: 'CSS',
              html: 'HTML',
              json: 'JSON',
              bash: 'Bash',
              python: 'Python',
              yaml: 'YAML',
              markdown: 'Markdown',
            },
          }),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <Separator />
                <BoldItalicUnderlineToggles />
                <CodeToggle />
                <Separator />
                <BlockTypeSelect />
                <Separator />
                <ListsToggle />
                <Separator />
                <CreateLink />
                <InsertTable />
                <InsertThematicBreak />
                <InsertCodeBlock />
              </>
            ),
          }),
        ]}
        contentEditableClassName="canopy-mdx-content"
      />
    )
  }

  return { default: WrappedEditor }
})

const FallbackTextarea: React.FC<Pick<MarkdownFieldProps, 'value' | 'onChange'>> = ({ value, onChange }) => (
  <Textarea
    value={value}
    onChange={(e) => onChange(e.currentTarget.value)}
    placeholder="Loading markdown editor..."
    autosize
    minRows={6}
    size="sm"
    readOnly
  />
)

export const MarkdownField: React.FC<MarkdownFieldProps> = ({ id, label, value, onChange, dataCanopyField }) => {
  const inputId = id ?? useId()
  const editorRef = useRef<MDXEditorMethods>(null)
  const lastExternalValue = useRef(value)

  // Sync external value changes into the editor (e.g., undo, reset, load)
  useEffect(() => {
    if (value !== lastExternalValue.current && editorRef.current) {
      editorRef.current.setMarkdown(value)
      lastExternalValue.current = value
    }
  }, [value])

  const handleChange = useCallback((newValue: string) => {
    lastExternalValue.current = newValue
    onChange(newValue)
  }, [onChange])

  return (
    <div id={inputId} data-canopy-field={dataCanopyField} className="canopy-markdown-field">
      {label && (
        <Text size="sm" fw={500} mb={4}>
          {label}
        </Text>
      )}
      <Suspense fallback={<FallbackTextarea value={value} onChange={onChange} />}>
        <MDXEditorLazy
          markdown={value}
          onChange={handleChange}
          editorRef={editorRef}
        />
      </Suspense>
    </div>
  )
}

export default MarkdownField
