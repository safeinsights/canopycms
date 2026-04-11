'use client'

import React, { Suspense, useId, useRef, useCallback, useEffect } from 'react'

import { Text, Textarea } from '@mantine/core'

import type { MDXEditorMethods } from '@mdxeditor/editor'
import { InsertEntryLink } from './entry-link'

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
      imagePlugin,
      tablePlugin,
      toolbarPlugin,
      codeBlockPlugin,
      codeMirrorPlugin,
      BoldItalicUnderlineToggles,
      BlockTypeSelect,
      ListsToggle,
      CreateLink,
      InsertImage,
      InsertTable,
      InsertThematicBreak,
      CodeToggle,
      InsertCodeBlock,
      UndoRedo,
      Separator,
      insertMarkdown$,
      usePublisher,
    },
  ] = await Promise.all([import('@mdxeditor/editor'), import('@mdxeditor/editor')])

  /** Toolbar wrapper that provides insertMarkdown to InsertEntryLink */
  const EntryLinkToolbarButton: React.FC = () => {
    const insertMarkdown = usePublisher(insertMarkdown$)
    return <InsertEntryLink onInsert={insertMarkdown} />
  }

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
          imagePlugin(),
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
                <EntryLinkToolbarButton />
                <InsertImage />
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

/** Style the editor wrapper with a white background and border so it's visually distinct from the form background. */
const editorWrapperStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--mantine-color-gray-4, #ced4da)',
  borderRadius: 'var(--mantine-radius-sm, 4px)',
  overflow: 'hidden',
}

/**
 * Mantine's global CSS reset strips styles from semantic HTML elements.
 * Restore them inside the MDXEditor content area so formatting is visible.
 */
const EditorContentStyles: React.FC = () => (
  <style>{`
    .canopy-mdx-content { min-height: 120px; padding: 8px 12px; }
    .canopy-mdx-content ul { list-style-type: disc; padding-left: 1.5em; margin: 0.5em 0; }
    .canopy-mdx-content ol { list-style-type: decimal; padding-left: 1.5em; margin: 0.5em 0; }
    .canopy-mdx-content ul ul { list-style-type: circle; }
    .canopy-mdx-content ul ul ul { list-style-type: square; }
    .canopy-mdx-content li { display: list-item; }
    .canopy-mdx-content h1 { font-size: 2em; font-weight: 700; margin: 0.67em 0; }
    .canopy-mdx-content h2 { font-size: 1.5em; font-weight: 600; margin: 0.83em 0; }
    .canopy-mdx-content h3 { font-size: 1.17em; font-weight: 600; margin: 1em 0; }
    .canopy-mdx-content h4 { font-size: 1em; font-weight: 600; margin: 1.33em 0; }
    .canopy-mdx-content h5 { font-size: 0.83em; font-weight: 600; margin: 1.67em 0; }
    .canopy-mdx-content h6 { font-size: 0.67em; font-weight: 600; margin: 2.33em 0; }
    .canopy-mdx-content blockquote {
      border-left: 3px solid var(--mantine-color-gray-4, #ced4da);
      padding-left: 1em;
      margin: 0.5em 0;
      color: var(--mantine-color-gray-7, #495057);
    }
    .canopy-mdx-content hr { border: none; border-top: 1px solid var(--mantine-color-gray-4, #ced4da); margin: 1em 0; }
    .canopy-mdx-content p { margin: 0.75em 0; }
    .canopy-mdx-content a { color: var(--mantine-color-blue-6, #228be6); text-decoration: underline; }
    .canopy-mdx-content img { max-width: 100%; height: auto; }
  `}</style>
)

const FallbackTextarea: React.FC<Pick<MarkdownFieldProps, 'value' | 'onChange'>> = ({
  value,
  onChange,
}) => (
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

export const MarkdownField: React.FC<MarkdownFieldProps> = ({
  id,
  label,
  value,
  onChange,
  dataCanopyField,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const editorRef = useRef<MDXEditorMethods>(null)
  const lastExternalValue = useRef(value)

  // Sync external value changes into the editor (e.g., undo, reset, load)
  useEffect(() => {
    if (value !== lastExternalValue.current && editorRef.current) {
      editorRef.current.setMarkdown(value)
      lastExternalValue.current = value
    }
  }, [value])

  const handleChange = useCallback(
    (newValue: string) => {
      lastExternalValue.current = newValue
      onChange(newValue)
    },
    [onChange],
  )

  return (
    <div id={inputId} data-canopy-field={dataCanopyField} className="canopy-markdown-field">
      {label && (
        <Text size="sm" fw={500} mb={4}>
          {label}
        </Text>
      )}
      <EditorContentStyles />
      <div style={editorWrapperStyle}>
        <Suspense fallback={<FallbackTextarea value={value} onChange={onChange} />}>
          <MDXEditorLazy markdown={value} onChange={handleChange} editorRef={editorRef} />
        </Suspense>
      </div>
    </div>
  )
}

export default MarkdownField
