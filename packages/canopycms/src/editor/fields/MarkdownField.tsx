'use client'

import React, { Suspense, useId, useRef, useCallback, useEffect, useState } from 'react'

import { Alert, Button, Group, Text, Textarea } from '@mantine/core'

import type { MDXEditorMethods } from '@mdxeditor/editor'
import { InsertEntryLink } from './entry-link'
import { MdxImageDialog } from './MdxImageDialog'
import { useApiClient } from '../context'
import { uploadAsset } from '../media/upload-asset'
import { FieldDescription, groupDescriptionProps } from './FieldDescription'

export interface MarkdownFieldProps {
  id?: string
  label?: string
  description?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
}

const MDXEditorLazy = React.lazy(async () => {
  const [
    {
      MDXEditor,
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
      useCellValues,
      saveImage$,
      closeImageDialog$,
      imageDialogState$,
    },
    { mdxJsxPlugins },
  ] = await Promise.all([import('@mdxeditor/editor'), import('./mdx-jsx-support')])

  const EntryLinkToolbarButton: React.FC = () => {
    const insertMarkdown = usePublisher(insertMarkdown$)
    return <InsertEntryLink onInsert={insertMarkdown} />
  }

  /**
   * Bridges mdxeditor's realm cells (reachable only once this lazy chunk has
   * loaded) into MdxImageDialog's plain-props interface, so that component
   * never imports `@mdxeditor/editor` at runtime — same pattern as
   * `EntryLinkToolbarButton` above.
   */
  const MdxImageDialogBridge: React.FC = () => {
    const [state] = useCellValues(imageDialogState$)
    const saveImage = usePublisher(saveImage$)
    const closeImageDialog = usePublisher(closeImageDialog$)
    return <MdxImageDialog state={state} onSave={saveImage} onClose={closeImageDialog} />
  }

  const WrappedEditor: React.FC<{
    markdown: string
    onChange: (value: string, initialMarkdownNormalize: boolean) => void
    onError: (payload: { error: string; source: string }) => void
    editorRef?: React.Ref<MDXEditorMethods>
    imageUploadHandler: (file: File) => Promise<string>
  }> = ({ markdown, onChange, onError, editorRef, imageUploadHandler }) => {
    return (
      <MDXEditor
        ref={editorRef}
        markdown={markdown}
        onChange={onChange}
        onError={onError}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          markdownShortcutPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          imagePlugin({ imageUploadHandler, ImageDialog: MdxImageDialogBridge }),
          tablePlugin(),
          ...mdxJsxPlugins(),
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
    .canopy-mdx-content .canopy-mdx-jsx {
      border: 1px dashed var(--mantine-color-gray-4, #ced4da);
      border-radius: 4px;
      padding: 2px 8px;
      margin: 0.5em 0;
    }
    .canopy-mdx-content .canopy-mdx-jsx-inline { display: inline-block; margin: 0 2px; }
    .canopy-mdx-content .canopy-mdx-jsx-tag {
      font-family: var(--mantine-font-family-monospace, monospace);
      font-size: 0.8em;
      color: var(--mantine-color-gray-6, #868e96);
    }
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

/**
 * `rich` is MDXEditor. `source` is a plain textarea over the stored text: the
 * user chose it (`reason: null`), or MDXEditor reported through `onError` that
 * it cannot represent the document. MDXEditor emits no `onChange` for a
 * document it rejected, so staying in rich mode then would discard every edit.
 */
type EditorMode = { kind: 'rich' } | { kind: 'source'; reason: string | null }

export const MarkdownField: React.FC<MarkdownFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const editorRef = useRef<MDXEditorMethods>(null)
  const lastExternalValue = useRef(value)
  const apiClient = useApiClient()
  const [mode, setMode] = useState<EditorMode>({ kind: 'rich' })

  // Drives both MDXEditor's drag/drop/paste upload and the custom image
  // dialog's Upload tab via the same presign/finalize-or-proxied pipeline
  // (media/upload-asset.ts). Memoized on the API client (itself memoized by
  // ApiClientProvider) so MDXEditor's plugin list doesn't churn per keystroke.
  const imageUploadHandler = useCallback(
    async (file: File) => {
      const asset = await uploadAsset(apiClient, file)
      return asset.src
    },
    [apiClient],
  )

  // Sync external value changes into the editor (e.g., undo, reset, load)
  useEffect(() => {
    if (value !== lastExternalValue.current && editorRef.current) {
      editorRef.current.setMarkdown(value)
      lastExternalValue.current = value
    }
  }, [value])

  const emitChange = useCallback(
    (newValue: string) => {
      lastExternalValue.current = newValue
      onChange(newValue)
    },
    [onChange],
  )

  // MDXEditor reports its re-serialization of the document it was mounted
  // with as a change flagged `initialMarkdownNormalize`. Forwarding it would
  // mark an entry nobody edited as modified and save the reformatted text.
  const handleEditorChange = useCallback(
    (newValue: string, initialMarkdownNormalize: boolean) => {
      if (!initialMarkdownNormalize) emitChange(newValue)
    },
    [emitChange],
  )

  // MDXEditor can report the error while it is still rendering (its import
  // runs as the editor is created), so the switch waits for a microtask
  // rather than updating this component mid-render.
  const handleEditorError = useCallback(({ error }: { error: string; source: string }) => {
    queueMicrotask(() => setMode({ kind: 'source', reason: error }))
  }, [])

  const showSource = mode.kind === 'source'

  return (
    <div
      id={inputId}
      data-canopy-field={dataCanopyField}
      className="canopy-markdown-field"
      {...groupDescriptionProps(inputId, description)}
    >
      <Group justify="space-between" align="flex-end" mb={4} wrap="nowrap">
        {label ? (
          <Text size="sm" fw={500}>
            {label}
          </Text>
        ) : (
          <span />
        )}
        <Button
          variant="subtle"
          size="compact-xs"
          data-testid="markdown-mode-toggle"
          onClick={() => setMode(showSource ? { kind: 'rich' } : { kind: 'source', reason: null })}
        >
          {showSource ? 'Rich text' : 'Edit source'}
        </Button>
      </Group>
      <FieldDescription baseId={inputId} description={description} />
      <EditorContentStyles />
      {showSource ? (
        <>
          {mode.reason !== null && (
            <Alert color="yellow" variant="light" mb="xs" data-testid="markdown-source-fallback">
              <Text size="sm">
                The rich-text editor can&apos;t show this content, so it is open as source. Your
                edits here are saved as usual.
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                {mode.reason}
              </Text>
            </Alert>
          )}
          <Textarea
            value={value}
            onChange={(e) => emitChange(e.currentTarget.value)}
            aria-label={label ? `${label} (source)` : 'Markdown source'}
            data-testid="markdown-source-editor"
            autosize
            minRows={10}
            size="sm"
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
        </>
      ) : (
        <div style={editorWrapperStyle}>
          <Suspense fallback={<FallbackTextarea value={value} onChange={onChange} />}>
            <MDXEditorLazy
              markdown={value}
              onChange={handleEditorChange}
              onError={handleEditorError}
              editorRef={editorRef}
              imageUploadHandler={imageUploadHandler}
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}
